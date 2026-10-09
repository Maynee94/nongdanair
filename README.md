# nongdanair
great


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


Đã gộp url_scan.js vào background.js; post_text.js vào background.js và dashboard.js.
Không cần giữ hai file helper cũ. dashboard.js vẫn phải tách khỏi HTML theo CSP của Chrome Manifest V3; background và content chạy ở ngữ cảnh khác nhau.


Cập nhật nghỉ theo lịch quét: đã bỏ ô thời lượng nghỉ riêng. Sau khi đăng thành
công và có bật tự động quét, tab vừa đăng chuyển sang Home và lướt tới mốc
crypto alarm tiếp theo. Lượt đăng trả về ngay, không giữ cryptoRunning trong
thời gian chờ. Khi quét lần sau, dừng lướt nhưng giữ tab để dùng lại cho quét X
và đăng. Tắt tự động hoặc bấm Dừng sẽ kết thúc lướt và đóng tab nghỉ. Thay đổi
chu kỳ quét sẽ cập nhật thời gian lướt theo lịch mới. Nếu tự động tắt hoặc không
có alarm kế tiếp, không lướt Home sau lần đăng thủ công.

Content Crypto: bỏ chủ đề ưu tiên, vai trò, quy tắc thêm và gắn link nguồn cuối bài; giữ kho bài mẫu. Độ dài có Từ–Đến (ký tự), mặc định 200–270; kiểm tra khoảng trước khi tạo/đăng và yêu cầu AI viết lại nếu chưa đạt. Cấu hình cũ chỉ có tối đa được giữ tối đa, tối thiểu lấy giá trị nhỏ hơn giữa 200 và tối đa.

Sửa quét website và lấy ảnh: bổ sung card link ngoài article/main, vùng div chứa
h1 + đoạn văn, nội dung JSON-LD, ảnh lazy-load/data-src/srcset/background và
og:image. Thay FileReader trong service worker bằng Blob.arrayBuffer + base64.
Bấm Quét ngay để cấp quyền HTTPS cho website và CDN ảnh; Chrome sẽ hiển thị
yêu cầu quyền rộng để tải được ảnh từ hostname khác nguồn tin.
Đã chạy 11 kiểm thử Node và Chromium trên trang HTML thử nghiệm (card div,
nội dung bài, ảnh lazy-load và OG). Chưa xác minh trực tiếp trên Coin68 vì
proxy của môi trường trả 403 khi kết nối; không coi kiểm thử fixture là kiểm
thử trang Coin68 thật.
