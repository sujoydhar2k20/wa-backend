'use strict';

// Call lifecycle for CallLog.status. The existing enum values are kept so the current web/mobile code keeps working.
const TERMINAL = new Set(['rejected', 'terminated', 'missed', 'failed']);

const TRANSITIONS = {
  // outbound (staff -> customer)
  permission_requested: ['permission_granted', 'failed', 'missed'],
  permission_granted: ['ringing', 'failed'],
  // both directions
  ringing: ['accepted', 'rejected', 'missed', 'failed', 'terminated'],
  accepted: ['terminated', 'failed'],
};

function isTerminal(status) {
  return TERMINAL.has(status);
}

function canTransition(from, to) {
  if (from === to) return false;
  if (isTerminal(from)) return false;
  return (TRANSITIONS[from] || []).includes(to);
}

// Map Meta's call webhook status/terminate values to our statuses.
function mapMetaCallStatus(metaStatus, { answered = false } = {}) {
  switch (String(metaStatus || '').toUpperCase()) {
    case 'RINGING': return 'ringing';
    case 'ACCEPTED': return 'accepted';
    case 'REJECTED': return 'rejected';
    case 'COMPLETED': return 'terminated';
    case 'FAILED': return answered ? 'failed' : 'failed';
    default: return null;
  }
}

module.exports = { isTerminal, canTransition, mapMetaCallStatus, TERMINAL };
