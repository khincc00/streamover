import { WebcastEvent } from 'tiktok-live-connector';

// Only https URLs are passed to the overlays, so a bad value can't load anything else.
const safeUrl = (url) => (typeof url === 'string' && url.startsWith('https://') ? url : '');
const firstUrl = (image) => safeUrl(image?.urlList?.[0] ?? image?.url?.[0]);

export function normalizeUser(user = {}) {
  const uniqueId = user.uniqueId ?? user.displayId ?? '';
  return {
    uniqueId,
    nickname: user.nickname || uniqueId || 'Penonton',
    avatar: firstUrl(user.avatarThumb) || safeUrl(user.profilePictureUrl),
  };
}

// Turns a raw connector event into the small shape the overlays use.
// Returns null for events we don't show.
export function normalizeEvent(type, data) {
  switch (type) {
    case WebcastEvent.CHAT:
      return { type: 'chat', user: normalizeUser(data.user), text: data.comment ?? data.content ?? '' };

    case WebcastEvent.GIFT: {
      // Gifts sent in a streak arrive one by one. Alert only when the streak ends,
      // otherwise a 50-gift combo would show 50 alerts.
      if (!data.repeatEnd) return null;
      const gift = data.gift ?? {};
      return {
        type: 'gift',
        user: normalizeUser(data.user),
        gift: {
          name: gift.name || data.giftName || 'Gift',
          image: firstUrl(gift.image) || safeUrl(data.giftPictureUrl),
          diamonds: gift.diamondCount ?? data.diamondCount ?? 0,
          count: data.repeatCount || 1,
        },
      };
    }

    case WebcastEvent.FOLLOW:
      return { type: 'follow', user: normalizeUser(data.user) };

    case WebcastEvent.SHARE:
      return { type: 'share', user: normalizeUser(data.user) };

    case WebcastEvent.ROOM_USER:
      return { type: 'viewers', count: Number(data.viewerCount ?? data.totalUser ?? data.total ?? 0) || 0 };

    default:
      return null;
  }
}
