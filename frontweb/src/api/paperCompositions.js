import request from '@/utils/request'

export const paperCompositionsAPI = {
  list(params = {}) { return request.get('/paper-compositions', { params }) },
  plan(storyboardId, body = {}) { return request.post(`/storyboards/${storyboardId}/paper-composition/plan`, body) },
  get(id) { return request.get(`/paper-compositions/${id}`) },
  update(id, body = {}) { return request.put(`/paper-compositions/${id}`, body) },
  validation(id, params = {}) { return request.get(`/paper-compositions/${id}/validation`, { params }) },
  lockTiming(id, body = {}) { return request.post(`/paper-compositions/${id}/lock-timing`, body) },
  proofFrames(id, body = {}) { return request.post(`/paper-compositions/${id}/proof-frames`, body) },
  render(id, body = {}) { return request.post(`/paper-compositions/${id}/render`, body) },
  duplicate(id, body = {}) { return request.post(`/paper-compositions/${id}/duplicate`, body) },
  addLayer(id, body = {}) { return request.post(`/paper-compositions/${id}/layers`, body) },
  updateLayer(id, body = {}) { return request.put(`/paper-layers/${id}`, body) },
  deleteLayer(id, body = {}) { return request.delete(`/paper-layers/${id}`, { data: body }) },
  doctor() { return request.get('/paper-render/doctor') },
}
