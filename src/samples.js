// Fake events for testing overlays without going live.
export const SAMPLES = {
  chat: () => ({
    type: 'chat',
    user: { uniqueId: 'budi_test', nickname: 'Budi', avatar: '' },
    text: 'Halo, ini pesan tes dari panel kontrol!',
  }),
  gift: () => ({
    type: 'gift',
    user: { uniqueId: 'sari_test', nickname: 'Sari', avatar: '' },
    gift: { name: 'Rose', image: '', diamonds: 1, count: 5 },
  }),
  follow: () => ({
    type: 'follow',
    user: { uniqueId: 'andi_test', nickname: 'Andi', avatar: '' },
  }),
  share: () => ({
    type: 'share',
    user: { uniqueId: 'rina_test', nickname: 'Rina', avatar: '' },
  }),
};
