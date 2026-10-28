//! 公开命令负责实例定位；调用方不接触私有路径。
use serde_json::{json, Value};
pub fn capabilities() -> Result<Value,String> {
    Ok(json!({"protocol":crate::read_bridge::PROTOCOL,"actions":["status","pages","read-page","inspect-page","open-page"],"transport":"host-command","credentials":false,"arbitraryScript":false}))
}
pub fn execute(input:&Value)->Result<Value,String> {
    #[cfg(not(unix))] { let _=input; Err("此平台尚未提供页面读取能力".into()) }
    #[cfg(unix)] {
        use std::{io::{Read,Write},os::unix::{net::UnixStream,fs::{MetadataExt,FileTypeExt}},time::Duration};
        let id=input["profileId"].as_str().ok_or("缺少实例编号")?;
        let profiles=crate::store::load_profiles()?;
        let p=profiles.iter().find(|p|p.id==id).ok_or("指定实例不存在")?;
        let revision=crate::read_bridge::source_revision(p)?;
        if input["sourceRevision"]!=revision || input["protocol"]!=crate::read_bridge::PROTOCOL {return Err("实例配置或读取协议已变化".into());}
        let path=crate::read_bridge::unix::socket_path(&crate::store::data_dir(),id);
        if !std::fs::symlink_metadata(&path).is_ok_and(|m|m.file_type().is_socket()&&m.uid()==unsafe{libc::geteuid()}&&m.mode()&0o077==0) {
            return Ok(json!({"available":false,"reason":"session_upgrade_required","message":"此运行实例尚无页面接口，请在保存当前工作后正常关闭并重新启动该实例"}));
        }
        let mut stream=UnixStream::connect(path).map_err(|_|"实例页面接口不可连接")?;
        stream.set_read_timeout(Some(Duration::from_secs(10))).map_err(|_|"接口不可读")?;
        stream.set_write_timeout(Some(Duration::from_secs(1))).map_err(|_|"接口不可写")?;
        let bytes=serde_json::to_vec(input).map_err(|_|"读取请求无效")?;
        if bytes.len()>16384 {return Err("读取请求过长".into());}
        stream.write_all(&bytes).and_then(|_|stream.write_all(b"\n")).map_err(|_|"读取请求未送达")?;
        let mut bytes=vec![];stream.take(524289).read_to_end(&mut bytes).map_err(|_|"读取请求未完成")?;
        if bytes.len()>524288{return Err("读取响应过长".into());}
        let r:Value=serde_json::from_slice(&bytes).map_err(|_|"读取响应格式无效")?;
        if r["ok"]!=true{return Err(match r["errorCode"].as_str() {
            Some("channel_unavailable")=>"浏览器页面通道已失效，需要正常重开当前实例",
            Some("response_limit")=>"页面响应超过读取上限，本次读取未完成",
            Some("read_timeout")=>"页面读取超时，请等待页面稳定后重新检查",
            _=>"实例页面读取失败，请重新检查",
        }.into());}
        let d=&r["data"];
        for key in ["requestId","profileId","sourceRevision","protocol","action"] {if d[key]!=input[key]{return Err("实例回应不匹配".into());}}
        let mut result=d.clone();result["available"]=json!(true);Ok(result)
    }
}
