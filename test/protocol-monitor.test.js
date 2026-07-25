const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildProtocolSnapshot,
  compareProtocolSnapshots,
  finalizeProtocolSnapshot
} = require('../src/protocol-monitor');

function field(type, id, rule) {
  return { type, id, ...(rule ? { rule } : {}) };
}

function makeProtocol() {
  const commonError = field('Error', 1);
  const methods = {
    Route: {
      requestConnection: ['ReqRequestConnection', 'ResRequestConnection'],
      heartbeat: ['ReqHeartbeat', 'ResHeartbeat']
    },
    Lobby: {
      login: ['ReqLogin', 'ResLogin'],
      oauth2Check: ['ReqOauth2Check', 'ResOauth2Check'],
      oauth2Auth: ['ReqOauth2Auth', 'ResOauth2Auth'],
      oauth2Login: ['ReqOauth2Login', 'ResLogin'],
      payMonthTicket: ['ReqCommon', 'ResPayMonthTicket'],
      fetchMonthTicketInfo: ['ReqCommon', 'ResMonthTicketInfo'],
      gainReviveCoin: ['ReqCommon', 'ResCommon'],
      fetchShopInfo: ['ReqCommon', 'ResShopInfo'],
      buyFromZHP: ['ReqBuyFromZHP', 'ResCommon']
    }
  };
  const service = entries => ({
    methods: Object.fromEntries(Object.entries(entries).map(([name, [requestType, responseType]]) => [name, { requestType, responseType }]))
  });
  return {
    nested: {
      lq: {
        nested: {
          Route: service(methods.Route),
          Lobby: service(methods.Lobby),
          Error: { fields: { code: field('int32', 1) } },
          Device: { fields: {
            platform: field('string', 1), hardware: field('string', 2), os: field('string', 3),
            os_version: field('string', 4), is_browser: field('bool', 5), software: field('string', 6),
            sale_platform: field('string', 7), hardware_vendor: field('string', 8), model_number: field('string', 9),
            screen_width: field('int32', 10), screen_height: field('int32', 11), user_agent: field('string', 12),
            screen_type: field('int32', 13)
          } },
          ClientVersion: { fields: { resource: field('string', 1), package: field('string', 2) } },
          Account: { fields: { gold: field('uint64', 1) } },
          Zhp: { fields: { goods: { type: 'uint32', id: 1, rule: 'repeated' } } },
          ShopInfo: { fields: { zhp: field('Zhp', 1) } },
          ReqRequestConnection: { fields: { type: field('int32', 1), route_id: field('string', 2), timestamp: field('int64', 3), platform: field('string', 6) } },
          ResRequestConnection: { fields: { error: commonError } },
          ReqHeartbeat: { fields: { delay: field('int32', 1), no_operation_counter: field('int32', 2), platform: field('int32', 3), network_quality: field('int32', 4) } },
          ResHeartbeat: { fields: { error: commonError } },
          ReqLogin: { fields: {
            account: field('string', 1), password: field('string', 2), reconnect: field('bool', 3), device: field('Device', 4),
            random_key: field('string', 5), client_version: field('ClientVersion', 6), gen_access_token: field('bool', 7),
            currency_platforms: { type: 'uint32', id: 8, rule: 'repeated' }, type: field('int32', 9),
            client_version_string: field('string', 10), tag: field('string', 11)
          } },
          ResLogin: { fields: { error: commonError, account: field('Account', 2) } },
          ReqOauth2Check: { fields: { type: field('int32', 1), access_token: field('string', 2) } },
          ResOauth2Check: { fields: { error: commonError, has_account: field('bool', 2) } },
          ReqOauth2Auth: { fields: { type: field('int32', 1), code: field('string', 2), uid: field('string', 3), client_version_string: field('string', 4) } },
          ResOauth2Auth: { fields: { error: commonError, access_token: field('string', 2) } },
          ReqOauth2Login: { fields: {
            type: field('int32', 1), access_token: field('string', 2), reconnect: field('bool', 3), device: field('Device', 4),
            random_key: field('string', 5), client_version: field('ClientVersion', 6), client_version_string: field('string', 7),
            currency_platforms: { type: 'uint32', id: 8, rule: 'repeated' }, tag: field('string', 9)
          } },
          ReqCommon: { fields: {} },
          ResCommon: { fields: { error: commonError } },
          ResPayMonthTicket: { fields: { error: commonError } },
          ResMonthTicketInfo: { fields: { error: commonError } },
          ResShopInfo: { fields: { shop_info: field('ShopInfo', 1) } },
          ReqBuyFromZHP: { fields: { goods_id: field('uint32', 1), count: field('uint32', 2) } }
        }
      }
    }
  };
}

test('snapshot follows used RPCs and nested fields', () => {
  const snapshot = buildProtocolSnapshot(makeProtocol(), { sourceVersion: '0.1.0.w' });
  const login = snapshot.rpcs['lq.Lobby.oauth2Login'];
  assert.equal(login.requestType, 'lq.ReqOauth2Login');
  assert.equal(login.requestPaths['device.platform'].at(-1).ownerType, 'lq.Device');
  assert.equal(login.responsePaths['account.gold'].at(-1).type, 'uint64');
  assert.equal(snapshot.sourceVersion, '0.1.0.w');
});

test('method signature and watched field changes are breaking', () => {
  const before = buildProtocolSnapshot(makeProtocol());
  const changed = makeProtocol();
  changed.nested.lq.nested.ResOauth2AuthV2 = JSON.parse(JSON.stringify(changed.nested.lq.nested.ResOauth2Auth));
  changed.nested.lq.nested.Lobby.methods.oauth2Auth.responseType = 'ResOauth2AuthV2';
  changed.nested.lq.nested.ReqOauth2Check.fields.access_token.id = 7;
  const report = compareProtocolSnapshots(before, buildProtocolSnapshot(changed));
  assert.ok(report.breaking.some(value => value.includes('responseType changed')));
  assert.ok(report.breaking.some(value => value.includes('access_token')));
});

test('new required request fields are breaking', () => {
  const before = buildProtocolSnapshot(makeProtocol());
  const changed = makeProtocol();
  changed.nested.lq.nested.Device.fields.attestation = field('string', 20, 'required');
  const report = compareProtocolSnapshots(before, buildProtocolSnapshot(changed));
  assert.ok(report.breaking.some(value => value.includes('device.attestation')));
});

test('unrelated optional additions only warn about the full protocol change', () => {
  const before = buildProtocolSnapshot(makeProtocol());
  const changed = makeProtocol();
  changed.nested.lq.nested.Unused = { fields: { value: field('string', 1) } };
  const report = compareProtocolSnapshots(before, buildProtocolSnapshot(changed));
  assert.deepEqual(report.breaking, []);
  assert.ok(report.warnings.some(value => value.includes('outside the attendance contract')));
});

test('pending snapshot is promoted only when finalized', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-monitor-'));
  const baselinePath = path.join(dir, 'protocol-snapshot.json');
  const pendingPath = path.join(dir, '.pending.json');
  fs.writeFileSync(pendingPath, '{"version":1}\n');
  assert.equal(fs.existsSync(baselinePath), false);
  assert.equal(finalizeProtocolSnapshot({ baselinePath, pendingPath }), true);
  assert.equal(fs.readFileSync(baselinePath, 'utf8'), '{"version":1}\n');
  assert.equal(fs.existsSync(pendingPath), false);
});
