const { app, BrowserWindow, session } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    show: true, // Show it so you can log in if needed
    webPreferences: {
      partition: 'persist:gemini'
    }
  });

  console.log('--- DISCOVERY MODE ---');
  console.log('1. Wait for the window to load.');
  console.log('2. If you see a login page, please log in.');
  console.log('3. I will log all /api/ requests below.');

  const filter = { urls: ['https://aistudio.google.com/api/*'] };
  
  session.fromPartition('persist:gemini').webRequest.onCompleted(filter, async (details) => {
    if (details.statusCode === 200) {
      console.log(`[API FOUND] ${details.url} (${details.method})`);
      
      // We can't easily read the body of a completed request from webRequest,
      // so we use executeJavaScript to fetch it again now that we know the URL.
      if (details.url.includes('usage') || details.url.includes('quota')) {
        try {
          const body = await win.webContents.executeJavaScript(`
            fetch('${details.url}').then(r => r.json())
          `);
          console.log('[DATA STRUCTURE]', JSON.stringify(body, null, 2));
          console.log('--- DISCOVERY SUCCESS ---');
        } catch (e) {
          console.log(`[FETCH FAILED] for ${details.url}: ${e.message}`);
        }
      }
    }
  });

  win.loadURL('https://aistudio.google.com/app/apikey');

  win.on('closed', () => {
    console.log('Discovery window closed.');
    app.quit();
  });
});
