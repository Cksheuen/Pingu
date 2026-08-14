# Silverwing-Inspired UI Style Summary

This document translates the visual language of `崩坏3 次生银翼 / Silverwing: N-EX` into a practical UI art direction for the Eva Blog MVP. It is an inspiration guide, not a license to copy character art, logos, screenshots, costumes, or game UI directly.

## Core Direction

The target aesthetic is cold aerial precision: a calm editorial system wrapped in white-silver armor surfaces, graphite technical structure, restrained cobalt/cyan energy, falcon-wing asymmetry, and translucent analysis panels.

The blog should feel like a mature, composed near-future writing console rather than a loud anime/game interface. It should remain readable, quiet, and product-like while borrowing the shape language, materials, and atmosphere of Silverwing.

## Style Pillars

### Frosted Armor Shell

Use pale surfaces as the dominant shell: frost white, silver gray, and very light blue. These areas should feel engineered and polished, like ceramic armor plates or cold brushed metal.

Recommended use:
- Main reading surfaces
- Article containers
- Editor canvas
- Empty states
- Dialog backgrounds

Avoid pure flat white pages with no material detail. Use subtle borders, bevel-like linework, and shadow separation.

### Dark Technical Core

Use graphite, blue-black, and deep slate as the structural layer underneath the pale shell. The dark layer should appear in navigation, status panels, side rails, command surfaces, and selected states.

Recommended use:
- App shell frame
- Local app/admin surfaces
- Auth and sync status modules
- Footer/status bar
- Debug or deployment information areas

The dark layer should support the system, not swallow the whole UI.

### Sparse Blue Energy

Cobalt and cyan should behave like signal, not decoration. Use them for focus, active state, AI analysis, sync status, progress, and important affordances.

Recommended use:
- Active navigation rail
- Focus ring
- Upload/sync status
- AI summary panel accent
- Comment submission action
- Small graph or signal indicators

Avoid flooding the screen with neon gradients. Energy accents should feel precise and expensive.

### Falcon-Wing Geometry

Silverwing’s silhouette suggests wing/cape asymmetry and tapered mechanical panels. Translate this into UI through angled rails, clipped panel corners, slender dividers, offset headers, and wing-like grouping.

Recommended use:
- Article list cards with a small angled leading edge
- Navigation tabs as segmented wing plates
- Summary panels with diagonal corner cuts
- Status chips with tapered ends
- Section dividers that feel like airframe seams

Avoid random cyberpunk shapes. Geometry should be consistent, calm, and functional.

### Holographic Barrier Layers

Use translucent panels and thin luminous outlines to evoke scatter barriers, analysis plates, and projected interfaces. The effect should be subtle enough for long-form reading.

Recommended use:
- AI summary drawer
- Current activity / music sync widget
- GitHub comment identity state
- Deployment or connection status
- Preview overlays

Avoid heavy blur, blurry glass cards, or illegible transparent text.

### Celestial / Star-Ring Signal

The source material repeatedly uses star-ring and celestial equipment language. Translate this into restrained orbit marks, coordinate ticks, circular progress rings, or small starfield grid details.

Recommended use:
- Loading and sync indicators
- Version/status badges
- AI summary generation state
- Local-to-online sync visualization

Avoid literal astrology decoration or busy sci-fi wallpaper.

## Color Direction

Suggested token set:

```css
:root {
  --surface-ice: #f7faff;
  --surface-frost: #edf4ff;
  --surface-silver: #d9e1f2;
  --surface-glass: rgba(183, 220, 255, 0.18);

  --ink-graphite: #101522;
  --ink-deep: #171f31;
  --ink-muted: #6d7890;
  --ink-soft: #9ba8bd;

  --accent-cobalt: #2f6fe4;
  --accent-cyan: #62e7ff;
  --accent-violet-shadow: #9aa8d8;
  --signal-rose: #ea6d86;
}
```

Usage ratio:
- 55-65% frost / silver surfaces
- 20-30% graphite technical structure
- 8-12% cobalt / cyan energy
- 1-3% rose or warm signal accent

The small rose accent is useful for comment activity, alerts, or human presence. Keep it rare so it feels intentional.

## Material Language

Use:
- Ceramic-white panels with thin blue-gray borders
- Brushed silver separators
- Matte graphite surfaces
- Transparent cyan analysis overlays
- Soft blue rim light on active controls
- Small technical labels and coordinate ticks

Avoid:
- Beige editorial themes
- Purple-blue gradient dominance
- Generic glassmorphism
- Heavy black cyberpunk dashboards
- Photo-collage anime backgrounds

## Typography

The system needs two voices:
- Reading voice: clean, highly legible, calm.
- Interface voice: compact, technical, precise.

Recommended approach:
- Use a readable sans-serif for the MVP unless the design model can provide a strong editorial pairing.
- Keep article body generous and quiet.
- Use uppercase or small technical labels sparingly for metadata and status.
- Do not use aggressive display fonts for ordinary controls.

## Page-Level Guidance

### Public Blog

The public blog should feel like a calm orbital reading deck. Prioritize article readability, comment clarity, and AI summary discoverability.

Recommended composition:
- Pale article canvas on a restrained dark/silver app shell
- Article list as a left or top segmented rail
- Selected article with a subtle luminous edge
- AI summary as a translucent analysis plate
- Comments as a comms module, not a social-media feed clone

### Local App / Admin

The local app can lean more technical because it handles upload, sync, currently-listening/current-activity state, and publishing.

Recommended composition:
- Darker command shell
- Pale editor canvas
- Sync status uplink panel
- Upload/publish controls with clear active and error states
- Compact verification/status badges

### GitHub Login / Commenting

Treat GitHub identity as a secure comms uplink. The UI should clearly show signed-in, signed-out, pending, and error states.

Do not imply real production auth is active if the MVP is using demo or simulated data.

### AI Summary / Recent Work

The AI summary area should feel like a generated analysis layer. It can use scan lines, progress rings, and cyan focus states, but it must remain readable and trustworthy.

Show:
- Article summary
- Recent work summary
- Confidence/source metadata where available
- Pending and failure states

### Mobile

Mobile should retain the art direction without becoming cramped:
- Stack modules vertically
- Reduce diagonal cuts
- Keep one active energy rail at a time
- Preserve article readability above decorative structure

## Component Guidance

Navigation:
- Segmented tactical rail or compact tab system.
- Active state: cobalt/cyan line, small glow, or tapered plate.

Article card:
- Frost surface, silver border, graphite metadata.
- Optional angled leading edge.
- Selected card gets a luminous blue edge.

Editor:
- Pale writing surface.
- Dark technical toolbar.
- Upload and publish actions should be visually distinct.

AI summary panel:
- Translucent blue-tinted analysis plate.
- Thin luminous frame.
- Clear loading, success, empty, and error states.

Comment module:
- Human and social, but still within the comms/uplink visual language.
- Use the rose accent only for human activity markers or notifications.

Status / sync widget:
- Ring, rail, or signal meter.
- Clearly separate local activity, music state, publish state, and remote deployment state.

## Motion Guidance

Use crisp, restrained motion:
- 120-180ms control transitions
- Small active-rail sweep
- Subtle AI summary scan during generation
- Gentle sync pulse
- No constant distracting background animation while reading

Motion should suggest precision and time-fracture calm, not arcade effects.

## Negative Prompt

Do not:
- Use official Honkai Impact 3rd logos, character portraits, screenshots, or UI directly.
- Build a collage of Silverwing images.
- Copy the exact outfit, weapon, or character silhouette as a mascot.
- Turn the blog into a combat HUD.
- Overuse neon blue, purple gradients, glitch effects, or starfields.
- Add unsupported features that are not in the MVP requirements.
- Hide article content behind decorative chrome.
- Make the UI look like a generic anime landing page.

## Design Model Deliverables

The design model should produce:
- A style board derived from the source materials, with extracted palette, material, shape, and motion notes.
- A refined design system token set.
- Desktop and mobile designs for the public blog.
- Desktop and mobile designs for the local app/admin workflow.
- States for GitHub login, comments, upload, sync, AI summary, empty data, loading, and error.
- Implementation notes that map visual decisions back to existing MVP routes/components.

