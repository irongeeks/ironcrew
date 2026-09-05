export function buildCharacterPrompt(identity: string, style: string): string {
  return `Create a character asset for the IronCrew virtual office.

CHARACTER / REFERENCE
${identity.trim() || "An original adult character with a recognisable silhouette, distinctive face and professional outfit."}

VISUAL STYLE
${style.trim() || "Modern cinematic illustration, clear rounded forms, refined materials and restrained graphite, teal and amber accents. No pixel art or retro-game rendering."}

DELIVERABLE
One full-body character, alone, facing the viewer in a slight three-quarter view. The camera is slightly elevated, about 10–15 degrees. Neutral standing pose; arms relaxed with a small gap from the torso. Preserve the requested identity and distinctive features. The entire head, hair, hands, accessories and feet must fit inside the canvas.

Use a 1024 × 1280 PNG with a genuinely transparent background (alpha channel), not a drawn checkerboard. Centre the character horizontally. Keep a 6% clear margin at the sides and above the head; align the soles of both feet on a common baseline at 92% of the canvas height. No scenery, floor, cast shadow, text, frame or interface. Use clean edges and readable shapes that still work when the character is displayed at approximately 65 × 81 pixels.

OPTIONAL PORTRAIT
As a separate file, produce a square 1024 × 1024 head-and-shoulders portrait of the exact same character, face centred, with the same lighting and transparent background.

OPTIONAL FUTURE ANIMATION VARIANTS
If additional images are requested, keep identity, proportions, camera, canvas size and feet baseline identical for idle, thinking, working, meeting, waiting for approval, rate limited and error. Export each as a separate transparent image. IronCrew currently displays the uploaded base image; live system-state indicators are added by the application. Do not combine frames into a sprite sheet.`;
}
