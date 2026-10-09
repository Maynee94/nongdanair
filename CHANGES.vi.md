Cập nhật Content Crypto

Chép gói này vào thư mục extension gốc và Reload ở chrome://extensions.
Giữ nguyên content_chatgpt.js, content_gemini.js, content_grok.js và icons/.
Gói này chưa chứa các file đó vì chúng không có trong tệp đính kèm.
File url_scan_dashboard.js từ gói trước không còn cần dùng, có thể xoá.

Tab Content Crypto > Nguồn tin: nhập URL website HTTPS, mỗi dòng một URL.
Bấm Quét ngay để cấp quyền truy cập và chạy quy trình hiện có: quét tối đa
5 bài mỗi website, lấy nội dung/ảnh, lọc tin mới, AI viết lại, lưu nháp hoặc
đăng tuỳ công tắc Duyệt bản nháp. Bật Copy ảnh từ bài gốc nếu cần đính ảnh.
Nguồn URL cũng được lưu để dùng khi tự động quét định kỳ; lần đầu phải cấp
quyền bằng Quét ngay. Website đăng nhập/chống bot/markup riêng có thể lỗi.
Bài có thời gian được ưu tiên mới nhất; thiếu thời gian giữ thứ tự trang.

Lướt Home khi nghỉ sau khi đăng: mặc định 1 phút, nhập 0 để tắt, tối đa 60 phút.
Chỉ chạy khi có bài đăng thành công, bao gồm đăng bản nháp đã duyệt; không
chạy khi chỉ quét hoặc tạo nháp. Luồng này dùng lại đúng tab vừa đăng bài, chuyển sang Home, cuộn lên/xuống,
mở đọc bài rồi trở lại theo logic Home trong file người dùng mới cung cấp.
Không tự like/reply/follow trong thời gian nghỉ. Nút Dừng kết thúc nghỉ.
Các luồng khác được tiếp tục sau khi nghỉ kết thúc. Lỗi mở Home được ghi log
và không làm mất trạng thái bài đã đăng.

Tích hợp phần Home từ ba file mới vào bản có Content Crypto; không thay toàn
bộ bằng ba file mới vì chúng không chứa luồng Content Crypto hiện tại.
Tiếp tục dùng tab Chrome thường và lọc dấu câu cho bài X như yêu cầu trước.

Kiểm tra: cú pháp JavaScript, manifest JSON, 5 test Node với API Chrome mô phỏng.
Chưa xác minh với website thực và tài khoản X trên Chrome.

Đã bỏ nút tab Tiện Ích khỏi thanh điều hướng và ẩn vùng nội dung tương ứng.

Cập nhật v3: sau khi đăng, giữ nguyên tab và điều hướng sang Home để nghỉ.
Không tạo tab nghỉ mới; đóng tab vừa đăng khi nghỉ xong hoặc bấm Dừng.

Cập nhật v4: Setting > Lướt Home khi tạm nghỉ có hai tỉ lệ phần trăm:
comment + like và chỉ like. Tổng <= 100; phần còn lại chỉ đọc, mặc định 0/0.
Áp dụng từ phiên nghỉ kế tiếp. Mỗi bài xét một lần/phiên; bỏ quảng cáo/bài của
chính bạn. Không tương tác nếu không xác định được username hiện tại.
Dùng prompt Reply AI hiện có (ngôn ngữ, giọng văn, độ dài và custom style từ
cấu hình Reply AI/Chéo Link đã lưu; provider/API trong Setting).
Lỗi AI thì bỏ qua bài, ghi nhật ký. Dừng khi đang đợi AI sẽ không gửi reply.
Comment đã bắt đầu gửi không thể thu hồi bằng nút Dừng.
Tỉ lệ là xác suất trên bài đủ điều kiện được xét, không đảm bảo số lượng chính
xác trong phiên ngắn. 7 test API mô phỏng đạt; chưa thử trên Chrome/X thực.
