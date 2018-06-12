import request = require('superagent')
import mpipe = require('mission-pipe')
import schedule = require('node-schedule')
import Sequelize = require('sequelize')
import sourceMapSupport = require('source-map-support')
import { models, dbSync, sequelize, Post } from './model'
import { create } from 'domain';

/*
 * 总体思路
 * 检查新内容(检查更新内容，每隔 x 秒检查前 y 个内容 & 每隔一段时间全量检查删除状态（同时检查更新内容）
 */

sourceMapSupport.install()
const Op = Sequelize.Op
const { Post, PostDetail } = models
const { Mpipe, Mission } = mpipe

interface remotePost {
  pid: string,
  text: string,
  type: string,
  timestamp: string,
  reply: string,
  likenum: string,
  extra: string,
  url: string
}

function difference<T> (thisSet: Set<T>, otherSet: Set<T>): Set<T> {  
  const diffSet = new Set()
  const values = Array.from(thisSet) 
  for (var i = 0; i < values.length; i++) {  
    if (!otherSet.has(values[i])) {  
      diffSet.add(values[i])  
    }  
  }  
  return diffSet
}

/*
 * keep error in this wrapper!
 * for outer loop to use
 */
async function wrapAsync (af: <T>() => Promise<T> | Promise<void> ) {
  try {
    await af()
  } catch (err) {
    console.error(err)
  }
}

async function wrapPromise<T> (promiseEmiter: () => Promise<T>, maxRetryTime: number): Promise<T> {
  let retryTimeLeft: number = maxRetryTime
  let ret: T = null
  while (true) {
    try {
      ret = await promiseEmiter()
    } catch (err) {
      if (retryTimeLeft <= 0) {
        throw err
      } else {
        retryTimeLeft--
        continue
      }
    }
    break
  }
  return ret
}

function queryPosts (page: number, pageSize: number = 1000): Promise<Array<remotePost>> {
  return request
    .get('http://www.pkuhelper.com/services/pkuhole/api.php')
    .query({
      action: 'search',
      page: page,
      pagesize: pageSize
    })
    .then(res => {
      return res.body.data
    })
}

async function sleep (ms: number): Promise<void> {
  await new Promise(res => setTimeout(() => res(), ms))
}

async function updatePostDetail (updatedPids: Array<number>, pids: Array<number>) {
  updatedPids.forEach(v => addPidDetailMission(v))
  const postDetailModels = await PostDetail.findAll({
    attributes: ['id', 'pid'],
    where: {
      pid: {
        [Op.in]: pids
      }
    }
  })
  const pidsNotSaved: Set<number> = new Set(pids)
  postDetailModels.forEach(v => pidsNotSaved.delete(v.pid))
  pidsNotSaved.forEach(v => addPidDetailMission(v))
}

/*
 * update recent post
 * relief the stress of remote server by only check the latest post
 * @param scale: number check post scale
 * @param second: number sleep after last request
 */
async function runUpdateLatestPost (scale: number = 300, second: number = 3): Promise<void> {
  while (true) {
    await sleep(second * 1000)
    try {
      const posts = await wrapPromise(() => queryPosts(0, scale), 5)
      const { updatedPids, createdPids, pids } = await syncPost(posts)
      console.log(`fire updateLatestPost`)
      console.log(`updateLatestPost: ${ createdPids.length } posts have been created`)
      console.log(`updateLatestPost: ${ updatedPids.length } posts have been updated`)
      await updatePostDetail(updatedPids, pids)
    } catch (err) {
      console.error(err)
    }
  }
}

/*
 * get all posts data
 * update all posts data
 * check and update delete status
 * @param second sleep bewteen per succeed success
 */
async function updateAllPost (second: number = 10, scale: number = 3000): Promise<void> {
  let localPids: Set<number> = new Set(), remotePids: Set<number> = new Set(), p = -1
  /*
   * get all posts data
   */
  while (++p + 1) {
    try {
      /*
       * get post data page
       */
      const posts: Array<remotePost> = await wrapPromise(() => queryPosts(p, scale), 5)
      console.log(`updateAllPost: get page ${p}`)
      console.log(`updateAllPost: ${ posts.length } posts have been got`)
      if (!posts.length) break
      /*
       * sync those data with db
       */
      const { updatedPids, createdPids, pids } = await syncPost(posts)
      console.log(`updateAllPost: ${ createdPids.length } posts have been created`)
      console.log(`updateAllPost: ${ updatedPids.length } posts have been updated`)
      await updatePostDetail(updatedPids, pids)
      pids.forEach(v => remotePids.add(v))
      await sleep(second * 1000)
      /*
       * todo: update detail of those updated post
       */
    } catch (err) {
      /*
       * if got too error here, this mission should be aborted!
       */
      console.error(err)
      console.log('updateAllPost: exit due to too many errors')
      return
    }
  }
  /*
   * check and update deleted info
   */
  try {
    let lastRemotePid: number = -1
    for (let pid of Array.from(remotePids)) {
      if (lastRemotePid <= pid) {
        lastRemotePid = pid
      }
    }
    
    (await Post.findAll({
      attributes: ['id', 'pid'],
      where: {
        pid: {
          [Op.lte]: lastRemotePid
        }
      }
    })).forEach(v => localPids.add(v.pid))
    
    const deletedPids = difference(localPids, remotePids)
    console.log(`updateAllPost: ${ deletedPids.size } posts have been deleted`)
    await Post.update({
      deleted: true
    }, {
      where: {
        pid: {
          [Op.in]: Array.from(deletedPids)
        }
      }
    })
  } catch (err) {
    console.error(err)
  }
  console.log('updateAllPost: exit normally')
}

/*
 * use posts data to update db
 * it may update or create posts
 * @return the updated pids, createdPids and all pids that passed
 */
async function syncPost (posts: Array<remotePost>): Promise<{ updatedPids: Array<number>, pids: Array<number>, createdPids: Array<number> }> {
  const updatedPids: Array<number> = []
  const createdPids: Array<number> = []
  const pids: Array<number> = posts.map(v => Number(v.pid))

  const postModels = await Post.findAll({
    attributes: ['id', 'pid', 'reply', 'likenum', 'extra'],
    where: {
      pid: {
        [Op.in]: pids
      }
    }
  })

  const localPid2postModel = new Map<number, Post>()
  postModels.forEach(v => {
    localPid2postModel.set(v.pid, v)
  })

  const postToBeCreated: Array<remotePost & { deleted: boolean, dangerous: boolean, createdAt: Date, updatedAt: Date }> = []
  for (let post of posts) {
    if (localPid2postModel.has(Number(post.pid))) {
      let postModel = localPid2postModel.get(Number(post.pid))
      if (postModel.reply != Number(post.reply) || postModel.likenum != Number(post.likenum) || postModel.extra != Number(post.extra)) {
        updatedPids.push(Number(post.pid))
        /*
         * I may use transanction here, but it isn't critical on performance
         */
        await Post.update(post, {
          where: {
            pid: postModel.pid
          }
        })
      }
    } else {
      createdPids.push(Number(post.pid))
      postToBeCreated.push({
        ...post,
        deleted: false,
        dangerous: false,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    }
  }
  /*
   * bulkInsert to save time
   */
  const queryInterface = sequelize.getQueryInterface()
  if (postToBeCreated.length) await queryInterface.bulkInsert('posts', postToBeCreated)
  
  return {
    updatedPids,
    createdPids,
    pids
  }
}

async function runUpdateAllPost () {
  while (true) {
    console.log(`start updateAllPost`)
    await wrapAsync(updateAllPost)
    console.log(`end updateAllPost`)
    sleep(1800000)
  }
}

function PostDetailGetter (): { addPidDetailMission: (pid: number) => void, run: () => Promise<never>} {
  const pidsNeedDetail = new Set<number>()
  function addPidDetailMission (pid: number): void {
    pidsNeedDetail.add(pid)
  }
  function getPostDetail (pid: number): Promise<string> {
    return request
      .get('http://www.pkuhelper.com/services/pkuhole/api.php')
      .query({
        action: 'getcomment',
        pid: pid,
        token: 'guest'
      })
      .then(res => {
        return res.text
      })
  }
  async function run (): Promise<never> {
    while (true) {
      try {
        if (!pidsNeedDetail.size) await sleep(1000)
        else {
          const pidsShot: Array<number> = []
          for (let pid of Array.from(pidsNeedDetail)) pidsShot.push(pid)
          for (let pid of pidsShot) {
            const resText = await wrapPromise(() => getPostDetail(pid), 5)
            const postDetailModel = await PostDetail.findOne({
              where: {
                pid: pid
              }
            })
            if (!postDetailModel) {
              console.log(`getDetail: create pid ${ pid }`)
              await PostDetail.create({
                pid: pid,
                text: resText
              })
            } else {
              console.log(`getDetail: update pid ${ pid }`)
              await PostDetail.update({
                text: resText
              }, {
                where: {
                  pid: pid
                }
              })
            }
            pidsNeedDetail.delete(pid)
          }
        }
      } catch (err) {
        console.error(err)
        await sleep(10000)
      }
    }
  }
  return {
    addPidDetailMission,
    run
  }
}

const postDetailGetter = PostDetailGetter()
const { addPidDetailMission } = postDetailGetter

async function main () {
  /*
   * alway sync db when service start
   */
  try {
    await dbSync()
  } catch (err) {
    console.error(err)
  }

  /*
   * register 3 service
   * updateLatestPost & updateAllPost
   */
  
  runUpdateLatestPost()
  runUpdateAllPost()
  postDetailGetter.run()
}

main()

export default {}