import request from '@/utils/request'

export const paperRigsAPI = {
  list(params = {}) { return request.get('/paper-rigs', { params }) },
  get(id) { return request.get(`/paper-rigs/${id}`) },
  create(body = {}) { return request.post('/paper-rigs', body) },
  update(id, body = {}) { return request.put(`/paper-rigs/${id}`, body) },
  delete(id, body = {}) { return request.delete(`/paper-rigs/${id}`, { data: body }) },
}
