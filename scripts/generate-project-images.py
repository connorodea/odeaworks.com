#!/usr/bin/env python3
"""Generate branded project preview cards as PNG images for the portfolio."""

import cairosvg
import os
import re

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "projects")

projects = [
    # === AI & Machine Learning (15 projects) ===
    {"name": "Vidmation", "tags": "Python  ·  FastAPI  ·  Claude API  ·  FFmpeg", "icon": "play", "color": "#6366f1"},
    {"name": "ClawdHub", "tags": "Python  ·  Textual  ·  Claude SDK", "icon": "terminal", "color": "#10a37f"},
    {"name": "QuickVisionz", "tags": "Python  ·  YOLO  ·  OpenCV", "icon": "eye", "color": "#f59e0b"},
    {"name": "AI Schematic Generator", "tags": "Python  ·  Claude API  ·  Electronics", "icon": "zap", "color": "#8b5cf6"},
    {"name": "GRIDIRON", "tags": "JavaScript  ·  YOLO8  ·  ML", "icon": "diamond", "color": "#ef4444"},
    {"name": "AI Call Spread Trader", "tags": "Python  ·  Finance  ·  ML", "icon": "dollar", "color": "#06b6d4"},
    {"name": "AI Real Estate Assistant", "tags": "Python  ·  AI  ·  SaaS", "icon": "diamond", "color": "#6366f1"},
    {"name": "AI YouTube Analyzer", "tags": "TypeScript  ·  AI  ·  YouTube API", "icon": "play", "color": "#ec4899"},
    {"name": "AI YouTube Pipeline", "tags": "Python  ·  TypeScript  ·  DeepInfra", "icon": "play", "color": "#6366f1"},
    {"name": "ClipsMachine", "tags": "Python  ·  FFmpeg  ·  AI", "icon": "play", "color": "#8b5cf6"},
    {"name": "AI Amazon Seller Central", "tags": "Python  ·  Amazon API  ·  AI", "icon": "dollar", "color": "#f59e0b"},
    {"name": "MortgageAI", "tags": "TypeScript  ·  Next.js  ·  AI", "icon": "dollar", "color": "#06b6d4"},
    {"name": "LunaScopeAI", "tags": "C  ·  AI  ·  Data Viz", "icon": "star", "color": "#ec4899"},
    {"name": "QuickVisionz SAM3", "tags": "Python  ·  SAM 3  ·  GPU  ·  Serverless", "icon": "eye", "color": "#f59e0b"},
    {"name": "YouTube Automation Pipeline", "tags": "Python  ·  React  ·  YouTube API  ·  AI", "icon": "play", "color": "#8b5cf6"},

    # === Software Engineering (15 projects) ===
    {"name": "QuickLotz WMS", "tags": "TypeScript  ·  React  ·  PostgreSQL", "icon": "grid", "color": "#10a37f"},
    {"name": "MedScribd", "tags": "TypeScript  ·  Next.js  ·  AI", "icon": "plus", "color": "#ef4444"},
    {"name": "Inquizit", "tags": "TypeScript  ·  Next.js  ·  AI", "icon": "diamond", "color": "#6366f1"},
    {"name": "QuickLotz Logistics", "tags": "TypeScript  ·  React  ·  PostgreSQL", "icon": "grid", "color": "#10a37f"},
    {"name": "VideoCallSync", "tags": "TypeScript  ·  WebRTC  ·  Real-time", "icon": "play", "color": "#6366f1"},
    {"name": "LiqOS", "tags": "TypeScript  ·  Terminal  ·  PostgreSQL", "icon": "terminal", "color": "#10a37f"},
    {"name": "Upscaled Distribution", "tags": "TypeScript  ·  Next.js  ·  React", "icon": "grid", "color": "#10a37f"},
    {"name": "QuickReturnz", "tags": "TypeScript  ·  React  ·  PostgreSQL", "icon": "grid", "color": "#10a37f"},
    {"name": "RateMyPsych", "tags": "TypeScript  ·  Next.js  ·  PostgreSQL  ·  Prisma", "icon": "plus", "color": "#ef4444"},
    {"name": "EbayAutolister", "tags": "Python  ·  eBay API  ·  CLI", "icon": "terminal", "color": "#f59e0b"},
    {"name": "NexSerp", "tags": "TypeScript  ·  Next.js  ·  API", "icon": "diamond", "color": "#6366f1"},
    {"name": "Upscaled Inventory", "tags": "TypeScript  ·  React  ·  PostgreSQL", "icon": "grid", "color": "#10a37f"},
    {"name": "Facebook Car Flipping", "tags": "Python  ·  Scraping  ·  Automation", "icon": "refresh", "color": "#f59e0b"},
    {"name": "MedScribd Agent UI", "tags": "TypeScript  ·  React  ·  AI Agents", "icon": "plus", "color": "#ef4444"},
    {"name": "Inquizit Frontend", "tags": "TypeScript  ·  React  ·  Next.js", "icon": "diamond", "color": "#6366f1"},

    # === Infrastructure & Tools (9 projects) ===
    {"name": "AgentAgent", "tags": "Shell  ·  tmux  ·  Python", "icon": "gear", "color": "#8b949e"},
    {"name": "Pinintel", "tags": "TypeScript  ·  Analytics  ·  API", "icon": "bars", "color": "#06b6d4"},
    {"name": "Meta Prompt Maker", "tags": "Next.js  ·  TypeScript  ·  AI", "icon": "terminal", "color": "#10a37f"},
    {"name": "GoDaddy CLI", "tags": "Shell  ·  GoDaddy API  ·  CLI", "icon": "terminal", "color": "#10a37f"},
    {"name": "UPC Database Scrapers", "tags": "TypeScript  ·  Web Scraping  ·  Data", "icon": "bars", "color": "#06b6d4"},
    {"name": "Facebook Marketplace Scraper", "tags": "Python  ·  Scraping  ·  Automation", "icon": "refresh", "color": "#f59e0b"},
    {"name": "Shopify Store Builder", "tags": "Python  ·  Shopify API  ·  AI", "icon": "grid", "color": "#10a37f"},
    {"name": "AdPilot", "tags": "TypeScript  ·  Meta API  ·  CLI", "icon": "terminal", "color": "#10a37f"},
    {"name": "Upscaled Inventory Processing", "tags": "Python  ·  Data Processing  ·  Automation", "icon": "gear", "color": "#8b949e"},
]


def slugify(name: str) -> str:
    """Convert project name to URL-friendly slug."""
    slug = name.lower().strip()
    slug = re.sub(r'[^a-z0-9\s-]', '', slug)
    slug = re.sub(r'[\s]+', '-', slug)
    slug = re.sub(r'-+', '-', slug)
    return slug


def get_icon_svg(icon_type: str, color: str) -> str:
    """Return SVG elements for the visual icon."""
    icons = {
        "play": f'''
            <polygon points="70,140 70,200 110,170" fill="{color}" opacity="0.5"/>
        ''',
        "terminal": f'''
            <text x="60" y="185" font-family="monospace" font-size="48" fill="{color}" opacity="0.5">&gt;_</text>
        ''',
        "eye": f'''
            <ellipse cx="95" cy="170" rx="35" ry="22" fill="none" stroke="{color}" stroke-width="2.5" opacity="0.5"/>
            <circle cx="95" cy="170" r="10" fill="{color}" opacity="0.5"/>
        ''',
        "zap": f'''
            <path d="M95,135 L80,170 L100,170 L85,205" fill="none" stroke="{color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>
        ''',
        "diamond": f'''
            <path d="M95,140 L120,170 L95,200 L70,170 Z" fill="none" stroke="{color}" stroke-width="2.5" opacity="0.5"/>
        ''',
        "dollar": f'''
            <text x="75" y="195" font-family="system-ui, -apple-system, sans-serif" font-size="56" font-weight="300" fill="{color}" opacity="0.5">$</text>
        ''',
        "star": f'''
            <path d="M95,140 L101,160 L122,160 L105,174 L112,195 L95,182 L78,195 L85,174 L68,160 L89,160 Z" fill="{color}" opacity="0.4"/>
        ''',
        "grid": f'''
            <rect x="65" y="148" width="22" height="22" rx="3" fill="{color}" opacity="0.4"/>
            <rect x="93" y="148" width="22" height="22" rx="3" fill="{color}" opacity="0.3"/>
            <rect x="65" y="176" width="22" height="22" rx="3" fill="{color}" opacity="0.3"/>
            <rect x="93" y="176" width="22" height="22" rx="3" fill="{color}" opacity="0.2"/>
        ''',
        "plus": f'''
            <path d="M95,145 L95,195 M70,170 L120,170" stroke="{color}" stroke-width="3" stroke-linecap="round" opacity="0.5"/>
        ''',
        "refresh": f'''
            <path d="M75,170 A25,25 0 1,1 95,195" fill="none" stroke="{color}" stroke-width="2.5" stroke-linecap="round" opacity="0.5"/>
            <polygon points="90,188 95,198 100,188" fill="{color}" opacity="0.5"/>
        ''',
        "gear": f'''
            <circle cx="95" cy="170" r="15" fill="none" stroke="{color}" stroke-width="2.5" opacity="0.4"/>
            <circle cx="95" cy="170" r="6" fill="{color}" opacity="0.4"/>
            <line x1="95" y1="148" x2="95" y2="155" stroke="{color}" stroke-width="2.5" opacity="0.4"/>
            <line x1="95" y1="185" x2="95" y2="192" stroke="{color}" stroke-width="2.5" opacity="0.4"/>
            <line x1="73" y1="170" x2="80" y2="170" stroke="{color}" stroke-width="2.5" opacity="0.4"/>
            <line x1="110" y1="170" x2="117" y2="170" stroke="{color}" stroke-width="2.5" opacity="0.4"/>
        ''',
        "bars": f'''
            <rect x="65" y="155" width="50" height="4" rx="2" fill="{color}" opacity="0.4"/>
            <rect x="65" y="168" width="38" height="4" rx="2" fill="{color}" opacity="0.35"/>
            <rect x="65" y="181" width="45" height="4" rx="2" fill="{color}" opacity="0.3"/>
        ''',
    }
    return icons.get(icon_type, icons["diamond"])


def generate_svg(project: dict) -> str:
    """Generate a premium dark project card SVG."""
    name = project["name"]
    tags = project["tags"]
    color = project["color"]
    icon_type = project["icon"]

    icon_svg = get_icon_svg(icon_type, color)

    # Escape ampersands and special chars for XML
    name_escaped = name.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    tags_escaped = tags.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    svg = f'''<svg width="800" height="450" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:{color};stop-opacity:0.12"/>
      <stop offset="100%" style="stop-color:#000000;stop-opacity:0"/>
    </linearGradient>
    <linearGradient id="shine" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:#ffffff;stop-opacity:0.03"/>
      <stop offset="100%" style="stop-color:#ffffff;stop-opacity:0"/>
    </linearGradient>
    <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="12" cy="12" r="0.6" fill="rgba(255,255,255,0.04)"/>
    </pattern>
    <clipPath id="rounded">
      <rect width="800" height="450" rx="0" ry="0"/>
    </clipPath>
  </defs>

  <!-- Background -->
  <rect width="800" height="450" fill="#080808"/>

  <!-- Gradient overlay -->
  <rect width="800" height="450" fill="url(#grad)"/>

  <!-- Dot grid pattern -->
  <rect width="800" height="450" fill="url(#dots)"/>

  <!-- Top shine -->
  <rect width="800" height="180" fill="url(#shine)"/>

  <!-- Subtle border glow on left -->
  <rect x="0" y="0" width="2" height="450" fill="{color}" opacity="0.2"/>

  <!-- Corner accent -->
  <rect x="680" y="0" width="120" height="2" fill="{color}" opacity="0.08"/>
  <rect x="798" y="0" width="2" height="120" fill="{color}" opacity="0.08"/>

  <!-- Icon -->
  {icon_svg}

  <!-- Project name -->
  <text x="60" y="275" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="38" font-weight="600" fill="#ffffff" letter-spacing="-0.5">{name_escaped}</text>

  <!-- Tags -->
  <text x="60" y="315" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="15" fill="#555555" letter-spacing="0.5">{tags_escaped}</text>

  <!-- Accent line -->
  <rect x="60" y="340" width="60" height="2" fill="{color}" opacity="0.6" rx="1"/>

  <!-- Bottom-right decorative element -->
  <circle cx="720" cy="380" r="40" fill="{color}" opacity="0.03"/>
  <circle cx="720" cy="380" r="20" fill="{color}" opacity="0.03"/>
</svg>'''

    return svg


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    for project in projects:
        slug = slugify(project["name"])
        svg_content = generate_svg(project)
        png_path = os.path.join(OUTPUT_DIR, f"{slug}.png")

        print(f"Generating: {slug}.png ...", end=" ")

        cairosvg.svg2png(
            bytestring=svg_content.encode("utf-8"),
            write_to=png_path,
            output_width=800,
            output_height=450,
            dpi=150,
        )

        # Get file size
        size_kb = os.path.getsize(png_path) / 1024
        print(f"OK ({size_kb:.0f} KB)")

    print(f"\nDone! Generated {len(projects)} project images in {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
