// 本地静态服务：pages-dist 目录，端口 3000，no-cache 便于调试
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'pages-dist');
const PORT = 3000;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/')
    urlPath = '/index.html';
  else if (!path.extname(urlPath) && !urlPath.endsWith('.html') && !urlPath.endsWith('/'))
    urlPath += '/index.html';
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.join(ROOT, urlPath);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // 数据请求不参与 SPA 兜底：缺失文件如实返回 404，避免 HTML 被当作 JSON 解析
    if (urlPath.startsWith('/data/')) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify({ error: 'Not Found', path: urlPath }));
    }
    // SPA 兜底：路由交由前端模块处理
    const idx = path.join(ROOT, 'index.html');
    if (fs.existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(idx));
    }
    res.writeHead(404); return res.end('Not Found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(fs.readFileSync(file));
}).listen(PORT, () => console.log(`serving pages-dist at http://localhost:${PORT}`));
