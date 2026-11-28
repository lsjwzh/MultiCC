'use strict';
// Account-ID oracle from the provider catalog at 3cc11ba5.
const officialId = type => `${type}-official`;
const ACCOUNT_ID_RE = /^[a-f0-9]{16}$/;
const accountProviderId = (type, accountId) => `${officialId(type)}-${accountId}`;
function accountIdOfProviderId(type, id) {
  const prefix = `${officialId(type)}-`;
  if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
  const accountId = id.slice(prefix.length);
  return ACCOUNT_ID_RE.test(accountId) ? accountId : null;
}
module.exports = { accountProviderId, accountIdOfProviderId };
