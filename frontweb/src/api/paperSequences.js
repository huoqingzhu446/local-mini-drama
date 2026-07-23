import request from '@/utils/request'

export const paperSequencesAPI = {
  list(params = {}) { return request.get('/paper-sequences', { params }) },
  get(id) { return request.get(`/paper-sequences/${id}`) },
  create(body = {}) { return request.post('/paper-sequences', body) },
  update(id, body = {}) { return request.put(`/paper-sequences/${id}`, body) },
  delete(id, body = {}) { return request.delete(`/paper-sequences/${id}`, { data: body }) },
}
