import Sequelize = require('sequelize')
import path = require('path')

const sequelize = new Sequelize('pkuhole', 'root', 'root', {
  // dialect: 'sqlite',
  dialect: 'mysql',
  // storage: path.resolve(__dirname, '..', 'data', 'pkuhole.sqlite'),
  logging: false
})

const Post: Sequelize.Model<Post, {}> = sequelize.define('post', {
  pid: {
    type: Sequelize.INTEGER
  },
  text: {
    type: Sequelize.TEXT
  },
  type: {
    type: Sequelize.CHAR
  },
  timestamp: {
    type: Sequelize.INTEGER
  },
  reply: {
    type: Sequelize.INTEGER
  },
  likenum: {
    type: Sequelize.INTEGER
  },
  extra: {
    type: Sequelize.INTEGER
  },
  url: {
    type: Sequelize.STRING
  },
  deleted: {
    type: Sequelize.BOOLEAN
  },
  dangerous: {
    type: Sequelize.BOOLEAN,
    defaultValue: false
  }
}, {
  indexes: [
    {
      unique: true,
      fields: ['pid']
    }
  ]
})

interface PostDetail {
  pid: number,
  text: string
}

const PostDetail: Sequelize.Model<PostDetail, {}> = sequelize.define('postDetail', {
  pid: Sequelize.INTEGER,
  text: Sequelize.TEXT('MEDIUM')
}, {
  indexes: [
    {
      unique: true,
      fields: ['pid']
    }
  ]
})

export { sequelize }

export const models = {
  Post,
  PostDetail
}

export function dbSync () {
  return sequelize.sync()
}

export interface Post {
  pid: number,
  text: string,
  type: string,
  timestamp: number,
  reply: number,
  likenum: number,
  extra: number,
  url: string,
  deleted: boolean
}