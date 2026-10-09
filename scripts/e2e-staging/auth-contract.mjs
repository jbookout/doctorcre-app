import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

const SECRET_MARKER = 'E2E_SESSION_SECRET';

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid staging auth contract ${label}`);
  return value;
}

export function readStagingAuthContract(source = contract) {
  const method = requireString(source.exchange?.method, 'exchange.method').toUpperCase();
  const path = requireString(source.exchange?.path, 'exchange.path');
  const authorization = requireString(source.exchange?.authorization, 'exchange.authorization');
  if (source.exchange?.body !== 'empty' || authorization.split(SECRET_MARKER).length !== 2) {
    throw new Error('Invalid staging auth contract exchange shape');
  }
  const sessionPath = requireString(source.session?.path, 'session.path');
  const cookie = requireString(source.session?.cookie, 'session.cookie');
  const actorSlug = requireString(source.session?.actor_slug, 'session.actor_slug');
  const principal = requireString(source.session?.e2e_principal, 'session.e2e_principal');

  return Object.freeze({
    exchange: Object.freeze({
      path,
      request(secret) {
        return {
          method,
          headers: { authorization: authorization.replace(SECRET_MARKER, secret) },
          maxRedirects: 0,
        };
      },
    }),
    session: Object.freeze({
      path: sessionPath,
      matches(actor) {
        return actor?.actor?.slug === actorSlug && actor?.e2e_principal === principal;
      },
      hasSecureCookie(cookies) {
        return cookies.some(value => value.name === cookie && value.httpOnly && value.secure);
      },
    }),
  });
}

export const stagingAuth = readStagingAuthContract();
