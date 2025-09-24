const els = {
  botToken: document.getElementById('botToken'),
  channelId: document.getElementById('channelId'),
  appUserName: document.getElementById('appUserName'),
  selector: document.getElementById('selector'),
  ignoreOwn: document.getElementById('ignoreOwn'),
  sendImages: document.getElementById('sendImages'),
  guildId: document.getElementById('guildId'),
  listenChannelId: document.getElementById('listenChannelId'),
  saveBtn: document.getElementById('saveBtn'),
  status: document.getElementById('status'),
};

async function restore() {
  const data = await chrome.storage.sync.get({
    botToken: '',
    channelId: '',
    appUserName: 'Messenger',
    selector: '',
    ignoreOwn: true,
    sendImages: false,
    guildId: '',
    listenChannelId: ''
  });
  Object.entries(data).forEach(([k, v]) => {
    if (k in els) {
      if (els[k].type === 'checkbox') els[k].checked = !!v;
      else els[k].value = v || '';
    }
  });
}
restore();

els.saveBtn.addEventListener('click', async () => {
  const payload = {
    botToken: els.botToken.value.trim(),
    channelId: els.channelId.value.trim(),
    appUserName: els.appUserName.value.trim(),
    selector: els.selector.value.trim(),
    ignoreOwn: !!els.ignoreOwn.checked,
    sendImages: !!els.sendImages.checked,
    guildId: els.guildId.value.trim(),
    listenChannelId: els.listenChannelId.value.trim(),
  };
  await chrome.storage.sync.set(payload);
  els.status.textContent = 'Saved.';
  setTimeout(() => (els.status.textContent = ''), 1200);
  chrome.runtime.sendMessage({ type: 'RELOAD_DISCORD_GATEWAY' });
});
