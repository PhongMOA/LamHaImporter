// prompts.ts — builder prompt cho GPT (Pha B). Dùng chung để dễ test/chỉnh.

import type { ProductDraft } from './types'

/** Prompt sinh mô tả chi tiết (HTML). Yêu cầu bọc ```html để extract sạch.
 *  `site` (tên + URL website của mình) để CTA "nơi mua hàng" trỏ ĐÚNG về web mình, không chung chung.
 *  `imageRequests` = yêu cầu tạo ảnh CHUNG cho mọi bài (cấu hình Settings); AI tự sinh mô tả
 *  [[IMAGE: ...]] theo từng yêu cầu này, đặt đúng vị trí. Phần tử rỗng → bỏ qua. */
export function buildDetailPrompt(
  draft: ProductDraft,
  site?: { name?: string; url?: string },
  imageRequests?: string[]
): string {
  // KHÔNG gửi link tham khảo: bài chưa đăng nên link sản phẩm chưa tồn tại.
  const ctx = [
    `Tên sản phẩm: ${draft.title}`,
    draft.model ? `Mã hàng/Model: ${draft.model}` : '',
    draft.brandSlug ? `Thương hiệu: ${draft.brandSlug}` : '',
    draft.madeinText ? `Xuất xứ: ${draft.madeinText}` : ''
  ]
    .filter(Boolean)
    .join('\n')

  const siteName = (site?.name || '').trim()
  const siteUrl = (site?.url || '').trim()
  const siteLabel = siteName || 'website của chúng tôi'

  const instruction = draft.detailInstruction || 'Viết mô tả giới thiệu sản phẩm thiết bị điện công nghiệp.'

  // Yêu cầu ảnh chung (bỏ phần tử rỗng) → mỗi yêu cầu = 1 placeholder [[IMAGE: ...]] trong bài.
  const imageReqs = (imageRequests || []).map((s) => (s || '').trim()).filter(Boolean)
  const n = imageReqs.length

  const sectionImg = n
    ? '3) Chức năng & nguyên lý hoạt động / ứng dụng — mô tả bằng lời rõ ràng, VÀ chèn các placeholder ảnh theo QUY TẮC ẢNH ở vị trí phù hợp.'
    : '3) Chức năng & nguyên lý hoạt động / ứng dụng — mô tả bằng lời rõ ràng.'

  const imgRules = n
    ? [
        '',
        'QUY TẮC ẢNH (bắt buộc):',
        `- Bài viết PHẢI có ĐÚNG ${n} ảnh minh hoạ, mỗi ảnh là MỘT placeholder [[IMAGE: ...]] nằm trên dòng riêng, đúng định dạng: <p>[[IMAGE: mô tả nội dung ảnh cần vẽ]]</p>.`,
        '- Với MỖI yêu cầu ảnh dưới đây, hãy đặt một placeholder ở vị trí phù hợp trong bài và viết phần mô tả trong [[IMAGE: ...]] bằng tiếng Việt: BÁM SÁT yêu cầu tương ứng và CỤ THỂ HOÁ theo đúng sản phẩm/model này (nêu rõ các thành phần/khối chính cần thể hiện):',
        ...imageReqs.map((r, i) => `  ${i + 1}. ${r}`),
        `- Đặt ĐÚNG ${n} placeholder [[IMAGE: ...]] theo đúng thứ tự yêu cầu ở trên; KHÔNG thêm/bớt số lượng ảnh.`,
        '- TUYỆT ĐỐI KHÔNG tự chèn thẻ <img> hay link ảnh từ web (dễ bịa URL sai → ảnh vỡ); CHỈ dùng placeholder [[IMAGE: ...]].'
      ]
    : []

  const outImgClause = n ? ' — ngoại trừ các placeholder [[IMAGE: ...]]' : ''

  return [
    'Bạn là chuyên gia viết nội dung sản phẩm thiết bị điện công nghiệp, đồng thời là chuyên gia SEO/GEO',
    '(tối ưu nội dung cho cả công cụ tìm kiếm Google lẫn các công cụ trả lời bằng AI) cho website thương mại.',
    '',
    'Thông tin sản phẩm:',
    ctx,
    '',
    'TRƯỚC KHI VIẾT (bắt buộc):',
    '- Tìm và đọc các bài viết, tài liệu, catalogue, datasheet liên quan trên mạng về đúng sản phẩm/model/hãng',
    '  này để nắm thông tin chính xác (đặc tính, ứng dụng, nguyên lý hoạt động). Tuyệt đối KHÔNG bịa thông số.',
    '',
    `Yêu cầu nội dung: ${instruction}`,
    '',
    'Hãy viết mô tả chi tiết bằng TIẾNG VIỆT, bố cục rõ ràng theo các mục:',
    '1) Giới thiệu & nguồn gốc thương hiệu',
    '2) Ưu điểm / tính năng nổi bật',
    sectionImg,
    `4) Cam kết & nơi mua hàng — kêu gọi mua hàng tại ${siteLabel} (xem QUY TẮC CTA).`,
    '',
    'QUY TẮC CTA (mục 4 — bắt buộc):',
    `- Lời kêu gọi hành động (CTA) phải hướng người đọc mua hàng CHÍNH HÃNG tại ${siteLabel}${siteUrl ? ` — ${siteUrl}` : ''}.`,
    `- Nêu ĐÍCH DANH tên website của chúng tôi (${siteLabel}); TUYỆT ĐỐI KHÔNG kêu gọi mua chung chung ("các đại lý uy tín", "nhà phân phối chính hãng"...) hay dẫn sang nơi khác.`,
    siteUrl
      ? `- Chèn đúng một liên kết CTA về web mình bằng thẻ <a>: <a href="${siteUrl}">${siteLabel}</a>.`
      : '- Có thể nhắc người đọc liên hệ qua Hotline/Zalo hiển thị trên chính website của chúng tôi.',
    '',
    'QUY TẮC TIÊU ĐỀ (bắt buộc):',
    '- Tiêu đề các MỤC CHÍNH (1, 2, 3, 4, FAQ...) dùng thẻ <h2>; tiêu đề phụ bên trong mỗi mục mới dùng <h3>.',
    '- ƯU TIÊN <h2> trước, chỉ dùng <h3> cho cấp nhỏ hơn; KHÔNG dùng toàn bộ <h3>.',
    '',
    'QUY TẮC THÔNG SỐ KỸ THUẬT (bắt buộc):',
    '- Nếu trình bày thông số/đặc tính kỹ thuật trong bài, PHẢI đặt trong bảng <table> (dùng <thead>/<tbody>/<tr>/<th>/<td>),',
    '  KHÔNG liệt kê thông số bằng <ul>/<li> hay đoạn văn xuôi.',
    '',
    'CHUẨN SEO/GEO:',
    '- Đưa tên sản phẩm/model vào tiêu đề <h2> đầu tiên và nhắc lại tự nhiên trong đoạn mở đầu.',
    '- Viết tự nhiên, súc tích, đúng trọng tâm; mỗi mục nên có câu trả lời rõ ràng để AI/answer engine dễ trích dẫn.',
    '- BẮT BUỘC có mục "Câu hỏi thường gặp (FAQ)" ở cuối bài với ÍT NHẤT 5 cặp hỏi–đáp liên quan trực tiếp tới sản phẩm.',
    '',
    'QUY TẮC IN ĐẬM TỪ KHOÁ (bắt buộc):',
    '- Tự động bôi đậm bằng <strong> các TỪ KHOÁ quan trọng trong bài: tên sản phẩm, model/mã hàng, thương hiệu,',
    '  và các cụm từ khoá chính về công năng/thông số/ứng dụng nổi bật (cụm người dùng hay tìm khi mua).',
    '- In đậm CÓ CHỌN LỌC, tự nhiên trong câu văn (KHÔNG bôi đậm cả câu/cả đoạn, KHÔNG lạm dụng);',
    '  mỗi từ khoá chỉ cần đậm ở lần xuất hiện đáng chú ý đầu tiên trong mỗi mục, tránh đậm tràn lan gây rối.',
    '- KHÔNG in đậm trong tiêu đề <h2>/<h3> (đã nổi bật sẵn) và KHÔNG in đậm nội dung bên trong <table>.',
    ...imgRules,
    '',
    'QUY TẮC ĐẦU RA (bắt buộc):',
    `- Trả về DUY NHẤT một khối mã \`\`\`html chứa HTML sạch (chỉ dùng <h2>, <h3>, <p>, <ul>, <li>, <strong>, <table>, <thead>, <tbody>, <tr>, <th>, <td>, và <a href> cho CTA)${outImgClause}.`,
    '- KHÔNG kèm lời dẫn, KHÔNG markdown ngoài khối mã, KHÔNG inline style.',
    '- Không bịa thông số kỹ thuật cụ thể; nội dung mang tính giới thiệu/marketing chính xác.'
  ].join('\n')
}

/** Prompt yêu cầu AI VẼ ảnh sơ đồ (đấu dây / nguyên lý) cho phần mô tả. Dùng kèm ask({image:true}). */
export function buildDetailImagePrompt(draft: ProductDraft, description: string): string {
  return [
    `Hãy VẼ một hình minh hoạ kỹ thuật cho sản phẩm "${draft.title}"${draft.model ? ` (model ${draft.model})` : ''}.`,
    `Nội dung hình cần vẽ: ${description}`,
    'Yêu cầu: sơ đồ kỹ thuật rõ ràng, sạch sẽ, nền trắng, bố cục ngang (landscape),',
    'phong cách kỹ thuật/điện công nghiệp; nếu có chú thích thì dùng tiếng Việt; KHÔNG watermark, KHÔNG logo.',
    'Chỉ trả về DUY NHẤT một ảnh.'
  ].join('\n')
}

/** Prompt sinh dữ liệu SEO cho sản phẩm: Title SEO, Meta description SEO và tags → JSON object.
 *  Bọc ```json. Gọi cùng conversation với detail để AI bám đúng ngữ cảnh bài vừa viết. */
export function buildSeoPrompt(draft: ProductDraft): string {
  const ctx = [
    `Tên sản phẩm: ${draft.title}`,
    draft.model ? `Mã hàng/Model: ${draft.model}` : '',
    draft.brandSlug ? `Thương hiệu: ${draft.brandSlug}` : '',
    draft.madeinText ? `Xuất xứ: ${draft.madeinText}` : ''
  ]
    .filter(Boolean)
    .join('\n')

  return [
    'Bạn là chuyên gia SEO cho website thương mại điện tử thiết bị điện công nghiệp.',
    '',
    'Thông tin sản phẩm:',
    ctx,
    '',
    'Hãy tạo dữ liệu SEO cho ĐÚNG sản phẩm trên, gồm 3 phần:',
    '- meta_title: Tiêu đề SEO hấp dẫn, chứa tên sản phẩm/model và từ khoá chính, dài khoảng 50–60 ký tự.',
    '- meta_desc: Mô tả SEO (meta description) súc tích, kêu gọi nhấp chuột, chứa từ khoá chính, dài khoảng 140–160 ký tự.',
    '- tags: 5–8 TỪ KHOÁ SEO mà người dùng thực sự gõ khi tìm mua sản phẩm này trên Google',
    '  (cụm từ tìm kiếm: "mua <model>", "<model> giá bao nhiêu", "<tên sp> chính hãng", "báo giá <hãng> <dòng sp>",',
    '  từ khoá theo công năng/ứng dụng/thông số nổi bật...). KHÔNG dùng nhãn phân loại chung chung',
    '  (ví dụ KHÔNG dùng: "thiết bị điện", "sản phẩm", "công nghiệp"). Mỗi tag là một cụm tìm kiếm tự nhiên, KHÔNG trùng lặp.',
    '',
    'QUY TẮC ĐẦU RA (bắt buộc):',
    '- Trả về DUY NHẤT một khối mã ```json chứa MỘT object JSON hợp lệ, đúng định dạng:',
    '  {"meta_title":"...","meta_desc":"...","tags":["...","..."]}',
    '- Tất cả nội dung bằng tiếng Việt; KHÔNG kèm lời dẫn, KHÔNG chú thích ngoài khối mã.',
    '- KHÔNG bịa thông số kỹ thuật cụ thể trong meta_title/meta_desc.'
  ].join('\n')
}

/** Prompt sinh bảng thông số kỹ thuật → JSON [{title,value}]. Bọc ```json. */
export function buildSpecPrompt(draft: ProductDraft): string {
  const instruction =
    draft.specInstruction || 'Liệt kê thông số kỹ thuật tiêu biểu của sản phẩm dựa trên model và dòng sản phẩm.'

  return [
    `Với sản phẩm "${draft.title}" (model ${draft.model || 'N/A'})${draft.brandSlug ? `, hãng ${draft.brandSlug}` : ''}:`,
    `Yêu cầu: ${instruction}`,
    '',
    'Trả về bảng thông số kỹ thuật dạng JSON, 10–15 dòng, mỗi dòng là một cặp tên–giá trị:',
    'Định dạng: [{"title":"Tên thông số","value":"Giá trị"}, ...]',
    '',
    'QUY TẮC ĐẦU RA (bắt buộc):',
    '- Trả về DUY NHẤT một khối mã ```json chứa mảng JSON hợp lệ.',
    '- title và value đều là string tiếng Việt; KHÔNG kèm lời dẫn, KHÔNG chú thích ngoài khối mã.',
    '- KHÔNG đưa các dòng: tên sản phẩm, model, mã hàng, xuất xứ, thương hiệu/hãng vào bảng (đã hiển thị ở nơi khác, tránh trùng lặp).',
    '- Chỉ liệt kê thông số kỹ thuật thực sự (điện áp, dòng định mức, công suất, số cực, tần số, tiếp điểm, tiêu chuẩn, kích thước...).',
    '- Nếu không chắc một giá trị, dùng "Liên hệ" thay vì bịa số liệu sai.'
  ].join('\n')
}
