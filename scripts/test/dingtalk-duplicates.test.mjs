import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeMessageHistory } from '../dingtalk-duplicates.mjs';
const message = (id,text,time='2026-10-13 10:00:00') => ({messageId:id,text,time,sender:id,duplicateCount:0});
const body='业务情况说明：'.repeat(20)+'订单数量1000台，价格1.5元。客户（剑桥）光模块 NPO，ins2 3测试。';

test('转发空行、非金融加号及有限括号补充合并，保留首次信息和每个原稿',()=>{
 const first=message('first',body);
 const copy=message('copy',body.replace('客户（剑桥）','客户（剑桥思科一体）').replace('光模块 NPO','光模块+NPO').replace('ins2 3','ins2+3').replaceAll('：','：\n\n'),'2026-10-13 11:00:00');
 const result=mergeMessageHistory([copy,first]);
 assert.equal(result.messages.length,1);assert.equal(result.messages[0].messageId,'first');assert.equal(result.messages[0].time,first.time);assert.equal(result.messages[0].text,first.text);
 assert.deepEqual(result.messages[0].duplicateSources,[{messageId:copy.messageId,time:copy.time,sender:copy.sender,text:copy.text}]);
 assert.equal(result.messages[0].duplicateCount,1);
 const next=mergeMessageHistory(result.messages,[copy,message('third',copy.text,'2026-10-13 12:00:00')]);
 assert.equal(next.added,0);assert.equal(next.messages.length,1);assert.equal(next.messages[0].time,first.time);assert.equal(next.messages[0].duplicateCount,2);
 assert.deepEqual(mergeMessageHistory(next.messages,[copy]).messages,next.messages);
});

test('报价、数量、正负号、下限、否定和客户变更不能误合并',()=>{
 const variants=[body,body.replace('1.5','15'),body.replace('1000','1200'),body.replace('价格1.5','价格-1.5'),body.replace('价格1.5','价格1.5+'),body.replace('订单数量','未确认订单数量'),body.replace('剑桥','另一家'),body.replace('剑桥','剑桥未确认'),body.replace('剑桥','剑桥没有订单'),body.replace('剑桥','剑桥停单'),body.replace('剑桥','剑桥？')];
 assert.equal(mergeMessageHistory(variants.map((text,i)=>message(String(i),text))).messages.length,variants.length);
 assert.equal(mergeMessageHistory([message('a','价格 1 0 元'),message('b','价格 10 元')]).messages.length,2);
 assert.equal(mergeMessageHistory([message('a','需求增长？'),message('b','需求增长。')]).messages.length,2);
});

test('不同短消息配图保留独立记录；长篇同文配图各版本完整留档',()=>{
 const a='[图片消息](mediaId=@first)',b='[图片消息](mediaId=@second)';
 assert.equal(mergeMessageHistory([message('a','看图'+a),message('b','看图'+b)]).messages.length,2);
 const result=mergeMessageHistory([message('a',body+a),message('b',body+b)]);
 assert.equal(result.messages.length,1);assert.ok(result.messages[0].duplicateSources[0].text.includes('@second'));
});

test('金额单位后加号、任何订单状态补充和真实附件名称变化均独立入库',()=>{
 const prefix='完整业务纪要：'.repeat(30);
 for(const [a,b] of [['收入100 元','收入100 元+'],['需求100 台','需求100 台+'],['收入100亿元','收入100亿元+'],['订单10万','订单10万+'],['客户（剑桥）','客户（剑桥待审批）'],['客户（剑桥）','客户（剑桥量产中）'],['客户（剑桥）','客户（剑桥转单）'],['客户（剑桥）','客户（剑桥订单翻倍）'],['\n订单100台.pdf','\n订单120台.pdf'],['\n客户甲.pdf','\n客户乙.pdf']]){
  assert.equal(mergeMessageHistory([message('a',prefix+a),message('b',prefix+b)]).messages.length,2,`${a} 和 ${b} 必须分开`);
 }
});

test('旧副本只有 ID 时补齐原稿，重复轮询不增加计数且首稿稳定',()=>{
 const first={...message('first',body),duplicateCount:1,duplicateMessageIds:['known-copy']};
 const copy=message('known-copy',body,'2026-10-13 11:00:00');
 const result=mergeMessageHistory([first],[copy]);
 assert.equal(result.messages[0].duplicateCount,1);assert.equal(result.added,0);assert.equal(result.messages[0].time,first.time);
 assert.deepEqual(result.messages[0].duplicateSources,[{messageId:copy.messageId,time:copy.time,sender:copy.sender,text:copy.text}]);
 assert.deepEqual(mergeMessageHistory(result.messages,[copy]).messages,result.messages);
});
