-- scenes.polished_prompt_single: 单图场景提示词缓存，避免复用四宫格场景提示词
ALTER TABLE scenes ADD COLUMN polished_prompt_single TEXT;
