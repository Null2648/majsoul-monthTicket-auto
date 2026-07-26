const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  appendNotificationSummary,
  supportsIssueNotifications
} = require('../scripts/report-automation-status');
const {
  classifyAutomationError
} = require('../src/automation-alert');

test('disabled repository Issues are treated as a supported no-op notification mode', () => {
  assert.equal(supportsIssueNotifications({ has_issues: false }), false);
  assert.equal(supportsIssueNotifications({ has_issues: true }), true);
  assert.equal(supportsIssueNotifications({}), true);
});

test('disabled-Issues explanation is written to the Actions summary', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-summary-'));
  const summary = path.join(directory, 'summary.md');
  appendNotificationSummary('Issues disabled; inspect diagnostics.', summary);
  const text = fs.readFileSync(summary, 'utf8');
  assert.match(text, /장애 알림/);
  assert.match(text, /Issues disabled/);
});

test('bounded YoStar refresh timeout is reported as metadata failure', () => {
  const error = Object.assign(new Error('YoStar WebSDK credential refresh exceeded 60s'), {
    code: 'YOSTAR_REFRESH_TIMEOUT'
  });
  assert.equal(classifyAutomationError(error), 'yostar-metadata');
});
