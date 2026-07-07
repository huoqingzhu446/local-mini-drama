import request from '@/utils/request'

export const promptStylesAPI = {
  list(params) {
    return request.get('/prompt-styles', { params: params || {} })
  },
  tags() {
    return request.get('/prompt-styles/tags')
  },
  get(id) {
    return request.get(`/prompt-styles/${id}`)
  },
  create(data) {
    return request.post('/prompt-styles', data)
  },
  update(id, data) {
    return request.put(`/prompt-styles/${id}`, data)
  },
  delete(id) {
    return request.delete(`/prompt-styles/${id}`)
  },
}
