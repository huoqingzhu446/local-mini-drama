import request from '@/utils/request'

export const visualStylesAPI = {
  get(dramaId) {
    return request.get(`/dramas/${dramaId}/visual-style`)
  },
  createDraft(dramaId, data = {}) {
    return request.put(`/dramas/${dramaId}/visual-style/draft`, data)
  },
  updateDraft(dramaId, versionId, data = {}) {
    return request.put(`/dramas/${dramaId}/visual-style/draft/${versionId}`, data)
  },
  activate(dramaId, versionId) {
    return request.post(`/dramas/${dramaId}/visual-style/activate`, { version_id: versionId })
  },
  impact(dramaId) {
    return request.get(`/dramas/${dramaId}/visual-style/impact`)
  },
  storyboardPreview(storyboardId, data = {}) {
    return request.post(`/storyboards/${storyboardId}/image-prompt-preview`, data)
  },
}
