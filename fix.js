const fs = require('fs');
let c = fs.readFileSync('index.js', 'utf8');
c = c.replace(/parse_mode: 'Markdown'/g, "parse_mode: 'HTML'");
c = c.replace(/\*([^\*]+)\*/g, '<b>$1</b>');
fs.writeFileSync('index.js', c);
