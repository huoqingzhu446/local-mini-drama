import axios from 'axios'
import { ElMessage } from 'element-plus'

const request = axios.create({
  baseURL: '/api/v1',
  timeout: 600000,
  headers: { 'Content-Type': 'application/json' }
})

function withApiError(error, backendError = {}) {
  if (backendError.message) error.message = backendError.message
  if (backendError.code) error.apiCode = backendError.code
  if (backendError.details) error.apiDetails = backendError.details
  return error
}

request.interceptors.response.use(
  (response) => {
    // blob 类型直接返回原始数据，不做 JSON 解包
    if (response.config?.responseType === 'blob') {
      return response.data
    }
    const res = response.data
    if (res.success !== false) {
      return res.data !== undefined ? res.data : res
    }
    return Promise.reject(withApiError(new Error(res.error?.message || '请求失败'), res.error || {}))
  },
  (error) => {
    // 提取后端实际错误信息（优先 API 返回的 message，而非 axios 通用 "status code 500"）
    const backendError = error.response?.data?.error || {}
    const backendCode = backendError.code
    const backendMsg = backendError.message
    const msg = backendMsg || error.message || '网络错误'
    // 过期视觉候选图由业务组件弹出二次确认；这里不要先弹一条英文错误，
    // 否则用户会在确认框外同时看到一条误导性的失败提示。
    if (![
      'STALE_STYLE_CANDIDATE',
      'PAPER_STUDIO_TRANSITION_GATE_FAILED',
      'PAPER_STUDIO_CONTINUITY_REPAIR_TARGET_STATE_INVALID',
      'PAPER_STUDIO_CONTINUITY_REPAIR_RENDER_ACTIVE',
    ].includes(backendCode)) ElMessage.error(msg)
    // 将真实错误信息写回 message，使组件 catch 块可直接用 e.message 获取可读内容
    return Promise.reject(withApiError(error, backendError))
  }
)

export default request
