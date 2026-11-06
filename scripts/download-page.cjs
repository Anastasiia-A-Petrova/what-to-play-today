const fs = require('fs');

fetch('https://www.thisdayinmusic.com/on-this-day-in-music-october-26/')
  .then(response => response.text())
  .then(html => {
    fs.writeFileSync('scripts/october-26.html', html, 'utf8');
    console.log('Сохранено:', html.length, 'символов');
  })
  .catch(error => {
    console.error('Ошибка:', error);
    process.exit(1);
  });
