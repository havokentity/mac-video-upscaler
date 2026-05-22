import { DEFAULT_SETTINGS } from '../common/modes';

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.sync.get('settings').then((result) => {
    if (!result.settings) {
      return chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
    }

    return undefined;
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-hud') {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (typeof tab.id === 'number') {
        void chrome.tabs.sendMessage(tab.id, { type: 'chrome-video-upscaler:toggle-hud' });
      }
    });
  }
});
