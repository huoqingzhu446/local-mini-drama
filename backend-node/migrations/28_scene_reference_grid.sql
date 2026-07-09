-- 场景九宫格参考板：作为视频模型辅助参考，不覆盖场景主图
ALTER TABLE scenes ADD COLUMN polished_prompt_nine TEXT;
ALTER TABLE scenes ADD COLUMN polished_prompt_nine_style_signature TEXT;
ALTER TABLE scenes ADD COLUMN reference_grid_image_url TEXT;
ALTER TABLE scenes ADD COLUMN reference_grid_local_path TEXT;
