/**
 * Express server for the WebDHT browser example
 * Serves the browser example and makes the source files available
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name using ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the src directory for direct access to the source files
app.use('/src', express.static(path.join(__dirname, '..', 'src')));

// Serve the example directory
app.use(express.static(path.join(__dirname)));

// Serve node_modules for dependencies like simple-peer
app.use('/node_modules', express.static(path.join(__dirname, '..', 'node_modules')));

// Serve the browser example at the root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start the server
app.listen(PORT, () => {
  console.log(`WebDHT example server running at http://localhost:${PORT}`);
  console.log(`Access the browser example at http://localhost:${PORT}`);
});
