# 🎵 What to Play Today?

**Discover the music history behind every day of the year.**

What to Play Today? is a music discovery website that explores what happened in music history on any given day.

From iconic album releases and legendary performances to artists' birthdays and memorable milestones, discover the stories behind the music — and find something worth listening to today.

🌐 **Website:** [What to Play Today?](https://what-to-play-today.pages.dev/)

---

## ✨ Features

- **Today in Music History** — discover notable events that happened on this day in music.
- **On This Day** — explore music history by browsing any date of the year.
- **Artist Birthdays** — discover musicians and performers born on each date.
- **Music Releases** — explore albums and songs associated with historical dates.
- **Music Discovery** — find artists, songs, and albums connected to memorable moments in music history.
- **Calendar Navigation** — browse the entire year and jump directly to any date.
- **Search & Filtering** — navigate through historical stories and find artists and events more easily.
- **Light & Dark Themes** — choose the appearance you prefer.

## 🛠️ Tech Stack

- [Astro](https://astro.build/) — static site generation and page architecture.
- JavaScript — data processing and application logic.
- CSS — responsive layouts, visual design, and themes.
- [MusicBrainz](https://musicbrainz.org/) — music metadata validation and enrichment.
- [Wikipedia](https://www.wikipedia.org/) — supplementary artist information and images.
- [Google Gemini](https://ai.google.dev/) — assistance with extracting structured music information from historical event descriptions.

## 📂 Project Structure

```text
/
├── public/                 # Static assets
├── src/
│   ├── components/         # Reusable UI components
│   ├── layouts/            # Shared page layouts
│   ├── pages/              # Home, calendar, and date pages
│   └── styles/             # Global styles
├── data/
│   ├── prepared/           # Enriched daily music data
│   ├── ai-music/           # AI-extracted music information
│   └── ...                 # Source data and metadata caches
├── scripts/                # Data collection and processing pipeline
├── astro.config.mjs
└── package.json
```

## ⚙️ Getting Started

### Requirements

- Node.js
- npm

### Installation

Clone the repository:

```bash
git clone https://github.com/Anastasiia-A-Petrova/what-to-play-today.git
cd what-to-play-today
```

Install dependencies:

```bash
npm install
```

### Development

Start the local development server:

```bash
npm run dev
```

Astro will make the website available at:

```text
http://localhost:4321
```

### Production Build

Generate the static website:

```bash
npm run build
```

The production-ready files will be generated in the `dist/` directory.

Preview the production build locally:

```bash
npm run preview
```

## 🔄 Data Processing

The project includes a dedicated data preparation pipeline that enriches historical music events with structured music information.

The processing workflow combines:

- Historical music event descriptions.
- AI-assisted extraction of artists, songs, and albums.
- MusicBrainz metadata validation.
- Wikipedia-based supplementary information and images.
- Cached results to reduce repeated API requests.

The pipeline is maintained separately from the website's static build process.

## 🚀 Deployment

The website is built as a static Astro site and can be deployed to static hosting platforms.

The project is configured for deployment through Cloudflare Pages, with GitHub as its source repository.

## 💡 Project Goal

Music history is full of fascinating stories, anniversaries, discoveries, and unexpected connections.

**What to Play Today?** brings these stories together in one place, making every day an opportunity to discover something new — or revisit something unforgettable.

---

Made with 🎵 and curiosity.