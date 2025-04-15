/**
 * Simple Express server for WebDHT demo
 */
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ES modules fix for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

// Serve static files from the project directory
app.use(express.static(__dirname));

// Redirect root to example directory
app.get('/', (req, res) => {
  res.redirect('/example');
});

// Serve the example app
app.get('/example', (req, res) => {
  res.sendFile(join(__dirname, 'example/index.html'));
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`SHA1 demo available at http://localhost:${PORT}/example/`);
});
