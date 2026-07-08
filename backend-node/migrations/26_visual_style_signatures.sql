ALTER TABLE characters ADD COLUMN polished_prompt_style_signature TEXT;
ALTER TABLE scenes ADD COLUMN polished_prompt_style_signature TEXT;
ALTER TABLE scenes ADD COLUMN polished_prompt_single_style_signature TEXT;
ALTER TABLE props ADD COLUMN prompt_style_signature TEXT;
ALTER TABLE storyboards ADD COLUMN polished_prompt_style_signature TEXT;
ALTER TABLE codex_image_jobs ADD COLUMN style_signature TEXT;
