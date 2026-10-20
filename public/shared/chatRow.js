// Membuat avatar: foto profil, atau huruf pertama kalau tidak ada foto.
export function avatarNode({ nickname, avatar }) {
  const pic = document.createElement(avatar ? 'img' : 'span');
  pic.className = 'avatar';
  if (avatar) {
    pic.src = avatar;
    pic.alt = '';
    pic.referrerPolicy = 'no-referrer';
  } else {
    pic.textContent = (nickname || '?').charAt(0).toUpperCase();
  }
  return pic;
}

// Membuat satu baris chat. Dipakai overlay OBS dan pratinjau template di panel,
// supaya tampilan di panel sama persis dengan yang tampil di OBS.
export function chatRow({ nickname, avatar, text }) {
  const row = document.createElement('div');
  row.className = 'msg';

  // textContent (not innerHTML) so chat text can't inject markup.
  const body = document.createElement('span');
  body.className = 'text';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = nickname;
  body.append(name, document.createTextNode(text));

  row.append(avatarNode({ nickname, avatar }), body);
  return row;
}
