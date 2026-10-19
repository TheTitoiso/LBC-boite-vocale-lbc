import { describe, expect, it } from 'vitest';
import { ChatwootClient, ChatwootError, sourceIdForInbox, unwrapContact, unwrapList } from '../src/clients/chatwoot.ts';
import { fetchMock, json, networkError, text } from './helpers/fetchMock.ts';

const contact = { id: 7, name: 'Marie Tremblay', email: null, phone_number: '+14505551234' };

function client(mock: ReturnType<typeof fetchMock>, auth: 'header' | 'bearer' = 'header') {
  return new ChatwootClient({
    baseUrl: 'https://app.chatwoot.com/',
    accountId: 139187,
    apiToken: 'jeton',
    auth,
    fetch: mock.fetch,
  });
}

describe('formes des réponses', () => {
  it.each([
    ['à la racine', contact],
    ['sous payload', { payload: contact }],
    ['sous payload.contact', { payload: { contact, contact_inbox: { source_id: 'abc' } } }],
    ['sous contact', { contact }],
  ])('contact %s', (_label, body) => {
    expect(unwrapContact(body).id).toBe(7);
  });

  it('contact sans id : erreur claire', () => {
    expect(() => unwrapContact({ payload: {} })).toThrow(/sans id/);
  });

  it.each([
    ['payload', { meta: {}, payload: [1, 2] }],
    ['data.payload', { data: { meta: {}, payload: [1, 2] } }],
    ['data', { data: [1, 2] }],
    ['tableau', [1, 2]],
  ])('liste sous %s', (_label, body) => {
    expect(unwrapList(body)).toEqual([1, 2]);
  });

  it('source_id par boîte, avec inbox.id ou inbox_id', () => {
    const withInboxes = {
      ...contact,
      contact_inboxes: [
        { source_id: 'a', inbox: { id: 1 } },
        { source_id: 'b', inbox_id: 2 },
      ],
    };
    expect(sourceIdForInbox(withInboxes, 1)).toBe('a');
    expect(sourceIdForInbox(withInboxes, 2)).toBe('b');
    expect(sourceIdForInbox(withInboxes, 3)).toBeNull();
  });
});

describe('ChatwootClient', () => {
  it('auth par en-tête api_access_token', async () => {
    const mock = fetchMock(json({ payload: [] }));
    await client(mock).searchContacts('+14505551234');
    const [request] = mock.requests;
    expect(request?.headers.get('api_access_token')).toBe('jeton');
    expect(request?.headers.get('authorization')).toBeNull();
    expect(request?.url.toString()).toBe(
      'https://app.chatwoot.com/api/v1/accounts/139187/contacts/search?q=%2B14505551234',
    );
  });

  it('auth Bearer (v4.19+)', async () => {
    const mock = fetchMock(json({ payload: [] }));
    await client(mock, 'bearer').searchContacts('x');
    expect(mock.requests[0]?.headers.get('authorization')).toBe('Bearer jeton');
    expect(mock.requests[0]?.headers.get('api_access_token')).toBeNull();
  });

  it('création de contact : source_id tiré de payload.contact_inbox', async () => {
    const mock = fetchMock(
      json({ payload: { contact, contact_inbox: { inbox: { id: 42 }, source_id: 'src-42' } } }),
    );
    const result = await client(mock).createContact({ inboxId: 42, name: 'Marie Tremblay', phoneNumber: '+14505551234' });
    expect(result).toEqual({ contact, sourceId: 'src-42' });
    expect(JSON.parse(String(mock.requests[0]?.body))).toEqual({
      inbox_id: 42,
      name: 'Marie Tremblay',
      phone_number: '+14505551234',
    });
  });

  it('création de contact : source_id tiré de contact_inboxes si la réponse est à plat', async () => {
    const mock = fetchMock(json({ ...contact, contact_inboxes: [{ source_id: 'src-42', inbox: { id: 42 } }] }));
    const result = await client(mock).createContact({ inboxId: 42, name: 'x' });
    expect(result.sourceId).toBe('src-42');
  });

  it('message entrant avec audio en multipart', async () => {
    const mock = fetchMock(json({ id: 99, content: 'Message vocal (0:47)', message_type: 0, private: false, created_at: 1 }));
    const message = await client(mock).createIncomingMessageWithAttachment(5, {
      content: 'Message vocal (0:47)',
      file: { data: new Uint8Array([1, 2, 3]), filename: 'message-vocal-RE1.mp3', contentType: 'audio/mpeg' },
    });
    expect(message.id).toBe(99);
    const form = mock.requests[0]?.body as FormData;
    expect(form.get('message_type')).toBe('incoming');
    expect(form.get('content')).toBe('Message vocal (0:47)');
    const file = form.get('attachments[]') as File;
    expect(file.name).toBe('message-vocal-RE1.mp3');
    expect(file.type).toBe('audio/mpeg');
    expect(file.size).toBe(3);
  });

  it('étiquettes : ajoute sans retirer celles en place', async () => {
    const mock = fetchMock(json({ payload: ['urgent'] }), json({ payload: ['urgent', 'boite-vocale'] }));
    const labels = await client(mock).addConversationLabels(5, ['boite-vocale']);
    expect(labels).toEqual(['urgent', 'boite-vocale']);
    expect(JSON.parse(String(mock.requests[1]?.body))).toEqual({ labels: ['urgent', 'boite-vocale'] });
  });

  it('étiquettes déjà présentes : aucun POST', async () => {
    const mock = fetchMock(json({ payload: ['boite-vocale', 'anglais'] }));
    await client(mock).addConversationLabels(5, ['anglais']);
    expect(mock.requests).toHaveLength(1);
  });

  it('GET : un nouvel essai après une erreur 500', async () => {
    const mock = fetchMock(text('oops', 502), json({ payload: [contact] }));
    expect(await client(mock).searchContacts('x')).toHaveLength(1);
  });

  it('POST : jamais de nouvel essai automatique', async () => {
    const mock = fetchMock(text('oops', 502));
    await expect(client(mock).createPrivateNote(5, 'note')).rejects.toMatchObject({ status: 502 });
    expect(mock.requests).toHaveLength(1);
  });

  it('erreur réseau sur une écriture : résultat incertain', async () => {
    const mock = fetchMock(networkError());
    const error = await client(mock)
      .createPrivateNote(5, 'note')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatwootError);
    expect((error as ChatwootError).uncertain).toBe(true);
  });

  it('le corps des erreurs est masqué', async () => {
    const mock = fetchMock(text('{"message":"Email marie@example.com has already been taken"}', 422));
    const error = (await client(mock)
      .updateContact(7, { email: 'marie@example.com' })
      .catch((e: unknown) => e)) as ChatwootError;
    expect(error.status).toBe(422);
    expect(error.message).not.toContain('marie@example.com');
    expect(error.message).toContain('[courriel]');
  });
});
