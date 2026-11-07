const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
