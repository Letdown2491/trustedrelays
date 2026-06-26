import type { NIP11Info, Nip66PolicySignals, RelayPolicy, RelayType, RelayReport } from './types.js';

/**
 * Policy classification result with reasoning
 */
export interface PolicyClassification {
  policy: RelayPolicy;
  confidence: number;  // 0-100
  reasons: string[];
  indicators: {
    authRequired: boolean;
    paymentRequired: boolean;
    restrictedWrites: boolean;
    powRequired: boolean;
    kindRestrictions: boolean;
    hasModeration: boolean;
  };
  // True when a monitor-observed (NIP-66) signal contradicted the relay's
  // self-claimed NIP-11 limitation. The observation wins for the indicator.
  observedConflict?: boolean;
}

/**
 * Classify a relay's policy based on NIP-11 info, relay type, and reports
 *
 * Policies:
 * - open: Accepts most events from anyone, minimal restrictions
 * - moderated: Open but with content moderation (spam filtering, ToS)
 * - curated: Restricted access (auth, payment, invite-only)
 * - specialized: Purpose-built for specific use case (NIP-46, DMs, etc.)
 */
export function classifyPolicy(
  nip11?: NIP11Info,
  relayType?: RelayType,
  reports?: RelayReport[],
  observed?: Nip66PolicySignals
): PolicyClassification {
  const reasons: string[] = [];
  const indicators = {
    authRequired: false,
    paymentRequired: false,
    restrictedWrites: false,
    powRequired: false,
    kindRestrictions: false,
    hasModeration: false,
  };

  // Check for specialized relay type first
  if (relayType === 'nip46' || relayType === 'specialized') {
    reasons.push(`Relay type is ${relayType}`);
    return {
      policy: 'specialized',
      confidence: 95,
      reasons,
      indicators,
    };
  }

  if (!nip11) {
    reasons.push('No NIP-11 info available');
    return {
      policy: 'open',
      confidence: 30,
      reasons,
      indicators,
    };
  }

  const lim = nip11.limitation;

  // Check access restrictions
  if (lim?.auth_required) {
    indicators.authRequired = true;
    reasons.push('Authentication required');
  }

  if (lim?.payment_required) {
    indicators.paymentRequired = true;
    reasons.push('Payment required');
  }

  if (lim?.restricted_writes) {
    indicators.restrictedWrites = true;
    reasons.push('Writes are restricted');
  }

  if (lim?.min_pow_difficulty && lim.min_pow_difficulty > 0) {
    indicators.powRequired = true;
    reasons.push(`PoW required (difficulty ${lim.min_pow_difficulty})`);
  }

  // Check for kind restrictions (indicates specialization or curation)
  // Note: NIP-11 doesn't have a standard field for this yet
  // but some relays use custom fields

  // Check for moderation indicators
  const hasContentPolicy = !!(nip11.description && (
    nip11.description.toLowerCase().includes('moderat') ||
    nip11.description.toLowerCase().includes('rules') ||
    nip11.description.toLowerCase().includes('policy') ||
    nip11.description.toLowerCase().includes('terms')
  ));

  if (hasContentPolicy) {
    indicators.hasModeration = true;
    reasons.push('Description mentions moderation/rules');
  }

  // Check spam reports as indicator of (lack of) moderation
  const spamReports = reports?.filter(r => r.reportType === 'spam') ?? [];
  const recentSpamReports = spamReports.filter(r => {
    const ageSeconds = Math.floor(Date.now() / 1000) - r.timestamp;
    return ageSeconds < 30 * 86400; // Last 30 days
  });

  if (recentSpamReports.length >= 5) {
    reasons.push(`${recentSpamReports.length} recent spam reports (may indicate weak moderation)`);
  }

  // Apply monitor-observed NIP-66 signals. Observations are harder to fake than
  // a self-published NIP-11 document, so when they contradict the claim the
  // observation wins for the indicator; agreement raises confidence.
  let observedConflict = false;
  let observedCorroborations = 0;
  if (observed) {
    const checks: Array<{
      key: keyof Pick<typeof indicators, 'authRequired' | 'paymentRequired' | 'restrictedWrites' | 'powRequired'>;
      value: boolean | undefined;
      label: string;
    }> = [
      { key: 'authRequired', value: observed.authRequired, label: 'auth' },
      { key: 'paymentRequired', value: observed.paymentRequired, label: 'payment' },
      { key: 'restrictedWrites', value: observed.restrictedWrites, label: 'restricted writes' },
      { key: 'powRequired', value: observed.powRequired, label: 'PoW' },
    ];
    for (const { key, value, label } of checks) {
      if (value === undefined) continue;
      if (value === indicators[key]) {
        if (value) observedCorroborations++;
      } else {
        indicators[key] = value;
        observedConflict = true;
        reasons.push(
          value
            ? `Monitors observe ${label} required despite NIP-11 not claiming it`
            : `Monitors do not observe ${label} despite NIP-11 claiming it`
        );
      }
    }

    // 'k' tag: finally populates the kind-restriction indicator NIP-11 can't express.
    if (observed.kindRestrictions) {
      if (!indicators.kindRestrictions) {
        reasons.push(`${observed.monitorCount} monitor(s) observe kind restrictions`);
      }
      indicators.kindRestrictions = true;
    }
  }

  // Classify based on indicators
  let policy: RelayPolicy;
  let confidence: number;

  // Curated: Has significant access barriers
  if (indicators.authRequired || indicators.paymentRequired) {
    policy = 'curated';
    confidence = 85;
    if (indicators.authRequired && indicators.paymentRequired) {
      confidence = 95;
    }
  }
  // Moderated: Has some restrictions or moderation indicators
  else if (indicators.restrictedWrites || indicators.hasModeration || indicators.powRequired || indicators.kindRestrictions) {
    policy = 'moderated';
    confidence = 70;
    if (indicators.restrictedWrites && indicators.hasModeration) {
      confidence = 85;
    }
  }
  // Open: No significant restrictions
  else {
    policy = 'open';
    confidence = 75;
    reasons.push('No significant access restrictions detected');
  }

  // Adjust confidence based on available information
  if (!nip11.limitation) {
    confidence = Math.max(50, confidence - 20);
    reasons.push('No limitation info in NIP-11 (lower confidence)');
  }

  // Monitor observations that corroborate the claimed restrictions raise
  // confidence (+5 each, capped); a claimed-vs-observed conflict is noted.
  if (observedCorroborations > 0) {
    confidence = Math.min(98, confidence + observedCorroborations * 5);
    reasons.push(`${observedCorroborations} restriction(s) corroborated by monitor observations`);
  }

  return {
    policy,
    confidence,
    reasons,
    indicators,
    observedConflict,
  };
}

/**
 * Check if a relay appears to be a paid relay
 */
export function isPaidRelay(nip11?: NIP11Info): boolean {
  if (!nip11) return false;

  // Check limitation field
  if (nip11.limitation?.payment_required) return true;

  // Check fees field
  if (nip11.fees) {
    const hasAdmission = nip11.fees.admission && nip11.fees.admission.length > 0;
    const hasSubscription = nip11.fees.subscription && nip11.fees.subscription.length > 0;
    if (hasAdmission || hasSubscription) return true;
  }

  return false;
}

/**
 * Check if a relay requires authentication
 */
export function requiresAuth(nip11?: NIP11Info): boolean {
  return nip11?.limitation?.auth_required ?? false;
}

/**
 * Get a human-readable description of the policy
 */
export function describePolicyClassification(classification: PolicyClassification): string {
  const lines: string[] = [
    `Policy: ${classification.policy}`,
    `Confidence: ${classification.confidence}%`,
  ];

  if (classification.reasons.length > 0) {
    lines.push('Reasons:');
    for (const reason of classification.reasons) {
      lines.push(`  - ${reason}`);
    }
  }

  const activeIndicators = Object.entries(classification.indicators)
    .filter(([_, v]) => v)
    .map(([k, _]) => k);

  if (activeIndicators.length > 0) {
    lines.push(`Indicators: ${activeIndicators.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Format policy for display
 */
export function formatPolicy(policy: RelayPolicy): string {
  const descriptions: Record<RelayPolicy, string> = {
    open: 'Open (accepts most events)',
    moderated: 'Moderated (content filtering)',
    curated: 'Curated (restricted access)',
    specialized: 'Specialized (specific use case)',
  };
  return descriptions[policy] || policy;
}
