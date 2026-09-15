/** Shared by still-image generation and inspection, not by the video's shot sequence. */
export const stillImageCompositionRule = {
  ruleId: 'composition:single_moment',
  description:
    'One full-frame camera view of one place at one instant. No collage, montage, storyboard, split screen, inset, before/after panels or repeated subjects depicting different times.',
};

export const stillImageGenerationInstructions =
  stillImageCompositionRule.description +
  ' This layout rule overrides scene directions, style requests and reference layouts. Show only what that camera can see at the target instant; history and item lists are state references, not a demand to show every event or object. Keep other moments and off-camera items off-screen. Never arrange supplied reference images as panels. ';

export const stillImageInspectionInstructions =
  'A multi-scene or multi-time layout is a major contradiction even if each panel matches the facts. Inspect the generated image itself; multiple supplied references do not authorize panels. Natural doors, windows, mirrors and screens within one continuous camera view are allowed. Missing off-screen tools or past events are not layout failures. ';
