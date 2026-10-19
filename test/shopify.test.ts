import { describe, expect, it } from 'vitest';
import { ShopifyClient } from '../src/clients/shopify.ts';
import { fetchMock, json } from './helpers/fetchMock.ts';

const token = (value = 'shpat_1', expiresIn = 86_399) =>
  json({ access_token: value, scope: 'read_customers,read_orders', expires_in: expiresIn });

const customerResponse = (nodes: unknown[]) => json({ data: { customers: { nodes } } });

const marie = {
  id: 'gid://shopify/Customer/1',
  displayName: 'Marie Tremblay',
  firstName: 'Marie',
  lastName: 'Tremblay',
  defaultEmailAddress: { emailAddress: 'marie@example.com' },
  numberOfOrders: '3',
  lastOrder: { name: '#64036', displayFulfillmentStatus: 'UNFULFILLED' },
};

function client(mock: ReturnType<typeof fetchMock>, now = () => 0) {
  return new ShopifyClient({
    shop: 'lesbellescombines',
    apiVersion: '2026-10',
    clientId: 'id',
    clientSecret: 'secret',
    fetch: mock.fetch,
    now,
  });
}

describe('jeton (client credentials)', () => {
  it('demande le jeton une fois et le garde en mémoire', async () => {
    const mock = fetchMock(token(), customerResponse([]), customerResponse([]));
    const shopify = client(mock);
    await shopify.findCustomerByPhone('+14505551234');
    await shopify.findCustomerByPhone('+14505551234');
    expect(mock.requests.filter((r) => r.url.pathname === '/admin/oauth/access_token')).toHaveLength(1);

    const tokenRequest = mock.requests[0];
    expect(tokenRequest?.url.toString()).toBe('https://lesbellescombines.myshopify.com/admin/oauth/access_token');
    expect(String(tokenRequest?.body)).toBe('grant_type=client_credentials&client_id=id&client_secret=secret');
    expect(shopify.grantedScopes).toEqual(['read_customers', 'read_orders']);
  });

  it('renouvelle le jeton avant son expiration', async () => {
    let now = 0;
    const mock = fetchMock(token('shpat_1'), customerResponse([]), token('shpat_2'), customerResponse([]));
    const shopify = client(mock, () => now);
    await shopify.findCustomerByPhone('+14505551234');
    now = (86_399 - 4 * 60) * 1000; // moins de 5 minutes avant l'expiration
    await shopify.findCustomerByPhone('+14505551234');
    expect(mock.requests[3]?.headers.get('x-shopify-access-token')).toBe('shpat_2');
  });

  it('une seule demande de jeton pour des appels simultanés', async () => {
    const mock = fetchMock(token(), customerResponse([]), customerResponse([]));
    const shopify = client(mock);
    await Promise.all([shopify.findCustomerByPhone('+1'), shopify.findCustomerByPhone('+2')]);
    expect(mock.requests.filter((r) => r.url.pathname === '/admin/oauth/access_token')).toHaveLength(1);
  });

  it('shop_not_permitted : message explicite', async () => {
    const mock = fetchMock(json({ error: 'shop_not_permitted', error_description: '…' }, 400));
    await expect(client(mock).getAccessToken()).rejects.toThrow(/même organisation/);
  });

  it('401 : redemande un jeton et réessaie une fois', async () => {
    const mock = fetchMock(token('shpat_1'), json({ errors: 'Unauthorized' }, 401), token('shpat_2'), customerResponse([]));
    expect(await client(mock).findCustomerByPhone('+14505551234')).toBeNull();
    expect(mock.requests[3]?.headers.get('x-shopify-access-token')).toBe('shpat_2');
  });
});

describe('CustomerByPhone', () => {
  it('cherche par numéro E.164, version 2026-10', async () => {
    const mock = fetchMock(token(), customerResponse([marie]));
    const customer = await client(mock).findCustomerByPhone('+14505551234');
    const request = mock.requests[1];
    expect(request?.url.toString()).toBe('https://lesbellescombines.myshopify.com/admin/api/2026-10/graphql.json');
    expect(JSON.parse(String(request?.body)).variables).toEqual({ q: 'phone:+14505551234' });
    expect(customer).toEqual({
      id: 'gid://shopify/Customer/1',
      name: 'Marie Tremblay',
      email: 'marie@example.com',
      numberOfOrders: 3,
      lastOrder: { name: '#64036', fulfillmentStatus: 'UNFULFILLED' },
    });
  });

  it('aucun client : null', async () => {
    const mock = fetchMock(token(), customerResponse([]));
    expect(await client(mock).findCustomerByPhone('+14505551234')).toBeNull();
  });

  it('displayName qui est un courriel : pas un nom', async () => {
    const mock = fetchMock(
      token(),
      customerResponse([{ ...marie, displayName: 'marie@example.com', firstName: null, lastName: null }]),
    );
    expect((await client(mock).findCustomerByPhone('+14505551234'))?.name).toBeNull();
  });

  it('erreurs GraphQL : exception', async () => {
    const mock = fetchMock(token(), json({ errors: [{ message: 'Field x does not exist' }] }));
    await expect(client(mock).findCustomerByPhone('+14505551234')).rejects.toThrow(/Field x/);
  });
});
