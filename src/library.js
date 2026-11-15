import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseVideoId } from './youtube.js';

// Playlists the streamer builds for YouTube Music, and a blacklist that keeps songs and viewers out of
// chat requests. Both belong to the account, so they're saved in the account's folder.
export const PLAYLIST_LIMIT = 30;
const NAME_MAX = 60;
const TITLE_MAX = 120;
const BLACKLIST_MAX = 100;

const clean = (value, max) => String(value ?? '').trim().slice(0, max);
const lower = (value) => String(value ?? '').trim().toLowerCase();

export class MusicLibrary {
  constructor(file) {
    this.file = file;
    this.playlists = [];
    this.blacklist = { songs: [], users: [] };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved.playlists)) this.playlists = saved.playlists;
      if (Array.isArray(saved.blacklist?.songs)) this.blacklist.songs = saved.blacklist.songs.map(String);
      if (Array.isArray(saved.blacklist?.users)) this.blacklist.users = saved.blacklist.users.map(String);
    } catch {
      // No library yet.
    }
  }

  snapshot() {
    return { playlists: this.playlists, blacklist: this.blacklist };
  }

  findPlaylist(id) {
    return this.playlists.find((playlist) => playlist.id === id) ?? null;
  }

  // Returns the new playlist, or throws with a message the panel can show.
  createPlaylist(name) {
    const title = clean(name, NAME_MAX);
    if (!title) throw new Error('Isi nama playlist dulu');
    if (this.playlists.length >= PLAYLIST_LIMIT) throw new Error(`Maksimal ${PLAYLIST_LIMIT} playlist`);
    const playlist = { id: crypto.randomUUID(), name: title, songs: [] };
    this.playlists.push(playlist);
    this.save();
    return playlist;
  }

  renamePlaylist(id, name) {
    const playlist = this.findPlaylist(id);
    const title = clean(name, NAME_MAX);
    if (!playlist) return null;
    if (!title) throw new Error('Isi nama playlist dulu');
    playlist.name = title;
    this.save();
    return playlist;
  }

  deletePlaylist(id) {
    const before = this.playlists.length;
    this.playlists = this.playlists.filter((playlist) => playlist.id !== id);
    if (this.playlists.length === before) return false;
    this.save();
    return true;
  }

  // Returns the new song, or null when the playlist doesn't exist. The link is a YouTube link the streamer pasted.
  addSong(playlistId, { title, artist, link }) {
    const playlist = this.findPlaylist(playlistId);
    const name = clean(title, TITLE_MAX);
    if (!playlist) return null;
    if (!name) throw new Error('Isi judul lagu dulu');
    // The link is optional: the extension finds songs by title and artist, while the player needs the link.
    const pasted = clean(link, 300);
    const videoId = pasted ? parseVideoId(pasted) : null;
    if (pasted && !videoId) throw new Error('Link YouTube tidak valid');
    const song = { id: crypto.randomUUID(), title: name, artist: clean(artist, TITLE_MAX), videoId };
    playlist.songs.push(song);
    this.save();
    return song;
  }

  // Adds songs that already have their video (used by playlist import). Saved once. Returns how many were added.
  addSongs(playlistId, songs) {
    const playlist = this.findPlaylist(playlistId);
    if (!playlist) return 0;
    const added = songs
      .map((song) => ({ id: crypto.randomUUID(), title: clean(song.title, TITLE_MAX), artist: clean(song.artist, TITLE_MAX), videoId: song.videoId }))
      .filter((song) => song.title && song.videoId);
    playlist.songs.push(...added);
    this.save();
    return added.length;
  }

  // Swaps a song's video for another upload of it, wherever the song is. Used when the owner blocks the first one.
  replaceVideo(songId, videoId) {
    for (const playlist of this.playlists) {
      const song = playlist.songs.find((entry) => entry.id === songId);
      if (!song) continue;
      song.videoId = videoId;
      this.save();
      return true;
    }
    return false;
  }

  removeSong(playlistId, songId) {
    const playlist = this.findPlaylist(playlistId);
    if (!playlist) return false;
    const before = playlist.songs.length;
    playlist.songs = playlist.songs.filter((song) => song.id !== songId);
    if (playlist.songs.length === before) return false;
    this.save();
    return true;
  }

  // type is 'song' (a word or title that must not appear in a request) or 'user' (a viewer's name).
  addBlocked(type, value) {
    const list = this.blockList(type);
    const term = clean(value, TITLE_MAX);
    if (!term) throw new Error(type === 'user' ? 'Isi nama penonton dulu' : 'Isi judul atau kata dulu');
    if (list.some((entry) => lower(entry) === lower(term))) return;
    if (list.length >= BLACKLIST_MAX) throw new Error(`Maksimal ${BLACKLIST_MAX} data di blacklist`);
    list.push(term);
    this.save();
  }

  removeBlocked(type, value) {
    const list = this.blockList(type);
    const before = list.length;
    const kept = list.filter((entry) => lower(entry) !== lower(value));
    if (kept.length === before) return;
    if (type === 'user') this.blacklist.users = kept;
    else this.blacklist.songs = kept;
    this.save();
  }

  // True when a chat request should be dropped: the viewer is blacklisted, or the request names a blacklisted song.
  isBlocked(user, request) {
    const names = [lower(user?.nickname), lower(user?.uniqueId)].filter(Boolean);
    if (this.blacklist.users.some((name) => names.includes(lower(name)))) return true;
    const text = lower(request);
    return this.blacklist.songs.some((term) => text.includes(lower(term)));
  }

  blockList(type) {
    if (type === 'user') return this.blacklist.users;
    if (type === 'song') return this.blacklist.songs;
    throw new Error('Jenis blacklist tidak dikenal');
  }

  save() {
    // Write to a temporary file first, so a crash mid-write can't leave a broken library.
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ playlists: this.playlists, blacklist: this.blacklist }));
    fs.renameSync(tmp, this.file);
  }
}
