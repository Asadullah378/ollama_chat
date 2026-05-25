const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const waitOn = require('wait-on');

let mainWindow;
let loadingWindow;
let isQuitting = false;

// When running in production (packaged), resources are in process.resourcesPath.
// When running in development, we want to look at the project root.
const isPackaged = app.isPackaged;
const composeCwd = isPackaged 
  ? process.resourcesPath 
  : path.join(__dirname, '..');

async function checkDocker() {
  return new Promise((resolve) => {
    exec('docker info', (error) => {
      if (error) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

function createLoadingWindow() {
  loadingWindow = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
    },
  });

  loadingWindow.loadFile('loading.html');
  loadingWindow.on('closed', () => {
    loadingWindow = null;
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false, // Don't show until we're ready
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load the FastAPI backend URL which now serves the frontend
  mainWindow.loadURL('http://localhost:8000');

  mainWindow.once('ready-to-show', () => {
    if (loadingWindow) {
      loadingWindow.close();
    }
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      dialog.showMessageBox({
        type: 'question',
        buttons: ['Yes', 'No'],
        title: 'Confirm',
        message: 'Are you sure you want to quit? This will stop the database and backend.'
      }).then(result => {
        if (result.response === 0) {
          isQuitting = true;
          app.quit();
        }
      });
    }
  });
}

async function startDockerCompose() {
  return new Promise((resolve, reject) => {
    // In production, we need to ensure the compose file exists in the resources path
    const composeCmd = 'docker compose up -d --build';
    
    console.log(`Executing: ${composeCmd} in ${composeCwd}`);
    
    // Send progress to loading window
    if (loadingWindow) {
      loadingWindow.webContents.executeJavaScript(`document.getElementById('status').innerText = 'Starting services (this may take a few minutes on first run to build MinerU)...'`);
    }

    const child = exec(composeCmd, { cwd: composeCwd }, (error, stdout, stderr) => {
      if (error) {
        console.error('Docker Compose Error:', stderr);
        reject(error);
        return;
      }
      resolve();
    });

    // Optional: pipe stdout to see build progress if we wanted to send to UI
    child.stdout.on('data', (data) => console.log(data));
    child.stderr.on('data', (data) => console.log(data));
  });
}

async function stopDockerCompose() {
  return new Promise((resolve) => {
    console.log(`Stopping docker compose in ${composeCwd}`);
    exec('docker compose down', { cwd: composeCwd }, (error) => {
      if (error) console.error('Error stopping compose:', error);
      resolve();
    });
  });
}

app.whenReady().then(async () => {
  createLoadingWindow();

  // 1. Check if Docker is running
  const isDockerRunning = await checkDocker();
  if (!isDockerRunning) {
    dialog.showErrorBox(
      'Docker Desktop Required',
      'Docker is not running or not installed. Please install and start Docker Desktop to use Ollama Studio.'
    );
    app.quit();
    return;
  }

  try {
    // 2. Start the Docker Compose stack
    await startDockerCompose();

    // 3. Wait for the backend to be healthy
    if (loadingWindow) {
      loadingWindow.webContents.executeJavaScript(`document.getElementById('status').innerText = 'Waiting for backend to be ready...'`);
    }

    await waitOn({
      resources: ['http-get://localhost:8000/health'],
      timeout: 300000, // Wait up to 5 minutes on first build
      interval: 2000,
    });

    // 4. Create and show the main window
    createMainWindow();
    
  } catch (error) {
    dialog.showErrorBox(
      'Startup Failed',
      `Failed to start the application stack:\n\n${error.message}`
    );
    app.quit();
  }
});

app.on('will-quit', async (event) => {
  // We need to delay quitting until compose down finishes, 
  // but electron doesn't easily wait for async tasks in will-quit.
  // Instead, we just spawn the process detached or wait synchronously.
  // We'll use a synchronous execSync approach here for simplicity on exit.
  try {
    const { execSync } = require('child_process');
    console.log('Shutting down Docker Compose synchronously...');
    execSync('docker compose down', { cwd: composeCwd, stdio: 'ignore' });
  } catch (e) {
    console.error('Failed to teardown docker compose:', e);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && !loadingWindow) {
    createMainWindow();
  }
});
