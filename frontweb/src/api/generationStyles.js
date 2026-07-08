import request from '@/utils/request'

export const generationStylesAPI = {
  list(params) {
    return request.get('/generation-styles', { params: params || {} })
  },
  get(id) {
    return request.get(`/generation-styles/${id}`)
  },
  create(data) {
    return request.post('/generation-styles', data)
  },
  update(id, data) {
    return request.put(`/generation-styles/${id}`, data)
  },
  delete(id) {
    return request.delete(`/generation-styles/${id}`)
  },
}
