import request from '@/utils/request'

export const paperAssetsAPI = {
  list(params = {}) { return request.get('/paper-assets', { params }) },
  get(id) { return request.get(`/paper-assets/${id}`) },
  create(body = {}) { return request.post('/paper-assets', body) },
  update(id, body = {}) { return request.put(`/paper-assets/${id}`, body) },
  delete(id, body = {}) { return request.delete(`/paper-assets/${id}`, { data: body }) },
  uploadSource(id, file, fields = {}) {
    const form = new FormData()
    form.append('file', file)
    Object.entries(fields || {}).forEach(([key, value]) => form.append(key, value == null ? '' : value))
    return request.post(`/paper-assets/${id}/source`, form, { headers: { 'Content-Type': 'multipart/form-data' } })
  },
  matte(id, body = {}) { return request.post(`/paper-assets/${id}/matte`, body) },
}
