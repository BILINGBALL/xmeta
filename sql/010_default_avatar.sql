-- 头像统一：没有自定义头像的用户落默认头像。
--
-- 现在 avatar 只有两种值：B站 图床上的地址，或者这张默认图。
-- 之前留空的补上，读的时候就不用到处判空。
update app_user
   set avatar = 'https://p0.hdslb.com/bfs/face/member/noface.jpg'
 where avatar is null or avatar = '';
