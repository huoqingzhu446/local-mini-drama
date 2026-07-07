import request from '@/utils/request'

export const codexImageJobAPI = {
  list(params) {
    return request.get('/codex-image-jobs', { params: params || {} })
  },
  get(id) {
    return request.get(`/codex-image-jobs/${id}`)
  },
  create(data) {
    return request.post('/codex-image-jobs', data)
  },
  pendingExport() {
    return request.get('/codex-image-jobs/pending-export')
  },
  importResults(data) {
    return request.post('/codex-image-jobs/import-results', data)
  },
  use(id, data) {
    return request.post(`/codex-image-jobs/${id}/use`, data || {})
  },
  cancel(id) {
    return request.post(`/codex-image-jobs/${id}/cancel`, {})
  }
}
