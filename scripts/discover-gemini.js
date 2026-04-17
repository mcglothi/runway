const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

(async () => {
  // Brave profile path on macOS
  const userDataDir = path.join(os.homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser');
  const executablePath = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

  console.log('🚀 Launching Brave with your existing session...');
  console.log(`📂 Using profile: ${userDataDir}`);
  
  try {
    const context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: false,
      // Pass the 'Default' profile specifically if needed, but launchPersistentContext 
      // usually takes the base and you specify profile via args if not Default
      args: ['--profile-directory=Default'] 
    });

    const page = await context.newPage();

    // Monitor ALL aistudio API traffic
    page.on('response', async response => {
      const url = response.url();
      if (url.includes('aistudio.google.com/api/')) {
        console.log(`[API] Intercepted: ${url} (${response.status()})`);
        
        if (url.includes('usage') || url.includes('quota') || url.includes('models')) {
          try {
            const json = await response.json();
            console.log(`\n✅ DATA FOUND for ${url}:`);
            console.log(JSON.stringify(json, null, 2));
            console.log('\n---------------------------\n');
          } catch (e) {
            // Some might not be JSON
          }
        }
      }
    });

    console.log('📂 Navigating to AI Studio...');
    await page.goto('https://aistudio.google.com/app/apikey');
    
    console.log('💡 Watching for usage data... (Script will auto-close in 60s)');
    await new Promise(resolve => setTimeout(resolve, 60000));
    await context.close();
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to launch Brave:', err.message);
    if (err.message.includes('browser is already open')) {
      console.error('👉 Please make sure ALL Brave windows are closed.');
    }
    process.exit(1);
  }
})();
