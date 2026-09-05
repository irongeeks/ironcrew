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

OPTIONAL ANIMATION
If an animation is requested, keep identity, proportions, camera, frame size and feet baseline identical. Export a transparent sprite sheet: one status per row, consecutive frames from left to right, all cells the same size, no gutters. Use these exact status names in a separate mapping: idle, thinking, working, in_meeting, waiting_for_input, waiting_for_approval, rate_limited, paused, error, offline. State the cell width, cell height, column count, row index (starting at zero), frame count, FPS and whether to loop. Maximum 64 frames per status, 256 in total, 30 FPS, 4096 pixels per image edge and 5 MiB per file. Error animation must finish, not loop. Static base images remain supported; live system-state indicators are added by the application.

OPTIONAL 3D EXPORT
If a 3D version is requested, export a single untextured GLB 2 file below 5 MiB with embedded geometry, normals, material colours and optional named skeletal animation clips using the same status names. No external files, textures, extensions or decoder dependencies. The model is an optional interactive preview; IronCrew's office remains 2D.`;
}
