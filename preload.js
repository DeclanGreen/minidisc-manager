const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (ch, ...args) => {
  const r = await ipcRenderer.invoke(ch, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld('md', {
  env: () => call('env'),
  connect: () => call('connect'),
  disconnect: () => call('disconnect'),
  readDisc: () => call('read-disc'),
  status: () => call('status'),
  renameDisc: (t) => call('rename-disc', t),
  renameTrack: (i, t) => call('rename-track', i, t),
  moveTrack: (from, to) => call('move-track', from, to),
  deleteTracks: (idx) => call('delete-tracks', idx),
  eraseDisc: () => call('erase-disc'),
  transport: (a) => call('transport', a),
  pickFiles: () => call('pick-files'),
  probeFiles: (paths) => call('probe-files', paths),
  pathForFile: (f) => webUtils.getPathForFile(f),
  getArt: (title, opts) => call('get-art', title, opts),
  chooseArt: (title) => call('choose-art', title),
  clearArt: (title) => call('clear-art', title),
  getLyrics: (q) => call('get-lyrics', q),
  youtubeSearch: (artist, title, seconds) => call('youtube-search', artist, title, seconds),
  spotifyAlbum: (q) => call('spotify-album', q),
  cdDrives: () => call('cd-drives'),
  cdRead: (letter) => call('cd-read', letter),
  cdEject: (letter) => call('cd-eject', letter),
  getSettings: () => call('get-settings'),
  setSettings: (patch) => call('set-settings', patch),
  openExternal: (url) => call('open-external', url),
  upload: (items, mode) => call('upload', items, mode),
  cancelUpload: () => call('cancel-upload'),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, p) => fn(p)),
});
