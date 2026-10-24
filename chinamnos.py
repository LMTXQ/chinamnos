"""
中国移动资费自动监控系统 - 青龙单文件版
Python v2.1.0

运行在青龙面板，由 cron 触发。
产出符合 data-schema-v2 的 snapshot / changelog / stats。

依赖: requests, pycryptodomex
环境变量: TARIFF_CONFIG (JSON 格式完整配置)

用法:
  python chinamnos.py                  # 正常采集
  python chinamnos.py --init           # 初始化基线（不通知）
  python chinamnos.py --test           # 测试模式（仅切换日志级别为 DEBUG，采集范围由配置决定）
  python chinamnos.py --rebuild-stats  # 从已有快照重建 stats（不采集，适合改了 stats 结构时）
  python chinamnos.py --deploy-frontend  # 仅部署前端文件（不采集、不重建 stats）
"""

# 采集端发布版本（每次改动 chinamnos.py 后手动 bump；run() 启动时随日志输出，便于排查青龙实际运行的代码版本）
SCRIPT_VERSION = "20261023a"

import os
import sys
import json
import re
import shutil
import subprocess
import tempfile
import time
import random
import logging
import threading
import datetime
import traceback
import ssl
import uuid
import io
import base64
import hashlib
import mimetypes
import string
import zipfile
from urllib.parse import urlparse, urljoin
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from Cryptodome.Cipher import AES
from Cryptodome.Util.Padding import pad, unpad

_STEALTH_JS_FILES = {
    'utils.js': r'''
() => {
  utils = {}
  utils.stripProxyFromErrors = (handler = {}) => {
    const newHandler = {}
    const traps = Object.getOwnPropertyNames(handler)
    traps.forEach(trap => {
      newHandler[trap] = function () {
        try {
          return handler[trap].apply(this, arguments || [])
        } catch (err) {
          if (!err || !err.stack || !err.stack.includes(`at `)) {
            throw err
          }
          const stripWithBlacklist = stack => {
            const blacklist = [
              `at Reflect.${trap} `,
              `at Object.${trap} `,
              `at Object.newHandler.<computed> [as ${trap}] `
            ]
            return (
              err.stack
                .split('\n')
                .filter((line, index) => index !== 1)
                .filter(line => !blacklist.some(bl => line.trim().startsWith(bl)))
                .join('\n')
            )
          }
          const stripWithAnchor = stack => {
            const stackArr = stack.split('\n')
            const anchor = `at Object.newHandler.<computed> [as ${trap}] `
            const anchorIndex = stackArr.findIndex(line =>
              line.trim().startsWith(anchor)
            )
            if (anchorIndex === -1) {
              return false
            }
            stackArr.splice(1, anchorIndex)
            return stackArr.join('\n')
          }
          err.stack = stripWithAnchor(err.stack) || stripWithBlacklist(err.stack)
          throw err
        }
      }
    })
    return newHandler
  }
  utils.stripErrorWithAnchor = (err, anchor) => {
    const stackArr = err.stack.split('\n')
    const anchorIndex = stackArr.findIndex(line => line.trim().startsWith(anchor))
    if (anchorIndex === -1) {
      return err
    }
    stackArr.splice(1, anchorIndex)
    err.stack = stackArr.join('\n')
    return err
  }
  utils.replaceProperty = (obj, propName, descriptorOverrides = {}) => {
    return Object.defineProperty(obj, propName, {
      ...(Object.getOwnPropertyDescriptor(obj, propName) || {}),
      ...descriptorOverrides
    })
  }
  utils.preloadCache = () => {
    if (utils.cache) {
      return
    }
    utils.cache = {
      Reflect: {
        get: Reflect.get.bind(Reflect),
        apply: Reflect.apply.bind(Reflect)
      },
      nativeToStringStr: Function.toString + ''
    }
  }
  utils.makeNativeString = (name = '') => {
    utils.preloadCache()
    return utils.cache.nativeToStringStr.replace('toString', name || '')
  }
  utils.patchToString = (obj, str = '') => {
    utils.preloadCache()
    const toStringProxy = new Proxy(Function.prototype.toString, {
      apply: function (target, ctx) {
        if (ctx === Function.prototype.toString) {
          return utils.makeNativeString('toString')
        }
        if (ctx === obj) {
          return str || utils.makeNativeString(obj.name)
        }
        const hasSameProto = Object.getPrototypeOf(
          Function.prototype.toString
        ).isPrototypeOf(ctx.toString)
        if (!hasSameProto) {
          return ctx.toString()
        }
        return target.call(ctx)
      }
    })
    utils.replaceProperty(Function.prototype, 'toString', {
      value: toStringProxy
    })
  }
  utils.patchToStringNested = (obj = {}) => {
    return utils.execRecursively(obj, ['function'], utils.patchToString)
  }
  utils.redirectToString = (proxyObj, originalObj) => {
    utils.preloadCache()
    const toStringProxy = new Proxy(Function.prototype.toString, {
      apply: function (target, ctx) {
        if (ctx === Function.prototype.toString) {
          return utils.makeNativeString('toString')
        }
        if (ctx === proxyObj) {
          const fallback = () =>
            originalObj && originalObj.name
              ? utils.makeNativeString(originalObj.name)
              : utils.makeNativeString(proxyObj.name)
          return originalObj + '' || fallback()
        }
        const hasSameProto = Object.getPrototypeOf(
          Function.prototype.toString
        ).isPrototypeOf(ctx.toString)
        if (!hasSameProto) {
          return ctx.toString()
        }
        return target.call(ctx)
      }
    })
    utils.replaceProperty(Function.prototype, 'toString', {
      value: toStringProxy
    })
  }
  utils.replaceWithProxy = (obj, propName, handler) => {
    utils.preloadCache()
    const originalObj = obj[propName]
    const proxyObj = new Proxy(obj[propName], utils.stripProxyFromErrors(handler))
    utils.replaceProperty(obj, propName, { value: proxyObj })
    utils.redirectToString(proxyObj, originalObj)
    return true
  }
  utils.mockWithProxy = (obj, propName, pseudoTarget, handler) => {
    utils.preloadCache()
    const proxyObj = new Proxy(pseudoTarget, utils.stripProxyFromErrors(handler))
    utils.replaceProperty(obj, propName, { value: proxyObj })
    utils.patchToString(proxyObj)
    return true
  }
  utils.createProxy = (pseudoTarget, handler) => {
    utils.preloadCache()
    const proxyObj = new Proxy(pseudoTarget, utils.stripProxyFromErrors(handler))
    utils.patchToString(proxyObj)
    return proxyObj
  }
  utils.splitObjPath = objPath => ({
    objName: objPath
      .split('.')
      .slice(0, -1)
      .join('.'),
    propName: objPath.split('.').slice(-1)[0]
  })
  utils.replaceObjPathWithProxy = (objPath, handler) => {
    const { objName, propName } = utils.splitObjPath(objPath)
    const obj = eval(objName)
    return utils.replaceWithProxy(obj, propName, handler)
  }
  utils.execRecursively = (obj = {}, typeFilter = [], fn) => {
    function recurse(obj) {
      for (const key in obj) {
        if (obj[key] === undefined) {
          continue
        }
        if (obj[key] && typeof obj[key] === 'object') {
          recurse(obj[key])
        } else {
          if (obj[key] && typeFilter.includes(typeof obj[key])) {
            fn.call(this, obj[key])
          }
        }
      }
    }
    recurse(obj)
    return obj
  }
  utils.stringifyFns = (fnObj = { hello: () => 'world' }) => {
    function fromEntries(iterable) {
      return [...iterable].reduce((obj, [key, val]) => {
        obj[key] = val
        return obj
      }, {})
    }
    return (Object.fromEntries || fromEntries)(
      Object.entries(fnObj)
        .filter(([key, value]) => typeof value === 'function')
        .map(([key, value]) => [key, value.toString()])
    )
  }
  utils.materializeFns = (fnStrObj = { hello: "() => 'world'" }) => {
    return Object.fromEntries(
      Object.entries(fnStrObj).map(([key, value]) => {
        if (value.startsWith('function')) {
          return [key, eval(`() => ${value}`)()]
        } else {
          return [key, eval(value)]
        }
      })
    )
  }
  utils.preloadCache()
}
''',
    'chrome.app.js': r'''
() => {
  if (!window.chrome) {
    Object.defineProperty(window, 'chrome', {
      writable: true,
      enumerable: true,
      configurable: false,
      value: {}
    })
  }
  if ('app' in window.chrome) {
    return
  }
  const makeError = {
    ErrorInInvocation: fn => {
      const err = new TypeError(`Error in invocation of app.${fn}()`)
      return utils.stripErrorWithAnchor(
        err,
        `at ${fn} (eval at <anonymous>`
      )
    }
  }
  const STATIC_DATA = JSON.parse(
    `
{
  "isInstalled": false,
  "InstallState": {
    "DISABLED": "disabled",
    "INSTALLED": "installed",
    "NOT_INSTALLED": "not_installed"
  },
  "RunningState": {
    "CANNOT_RUN": "cannot_run",
    "READY_TO_RUN": "ready_to_run",
    "RUNNING": "running"
  }
}
        `.trim()
  )
  window.chrome.app = {
    ...STATIC_DATA,
    get isInstalled() {
      return false
    },
    getDetails: function getDetails() {
      if (arguments.length) {
        throw makeError.ErrorInInvocation(`getDetails`)
      }
      return null
    },
    getIsInstalled: function getDetails() {
      if (arguments.length) {
        throw makeError.ErrorInInvocation(`getIsInstalled`)
      }
      return false
    },
    runningState: function getDetails() {
      if (arguments.length) {
        throw makeError.ErrorInInvocation(`runningState`)
      }
      return 'cannot_run'
    }
  }
  utils.patchToStringNested(window.chrome.app)
}
''',
    'chrome.runtime.js': r'''
(runOnInsecureOrigins) => {
  const STATIC_DATA = {
    "OnInstalledReason": {
      "CHROME_UPDATE": "chrome_update",
      "INSTALL": "install",
      "SHARED_MODULE_UPDATE": "shared_module_update",
      "UPDATE": "update"
    },
    "OnRestartRequiredReason": {
      "APP_UPDATE": "app_update",
      "OS_UPDATE": "os_update",
      "PERIODIC": "periodic"
    },
    "PlatformArch": {
      "ARM": "arm",
      "ARM64": "arm64",
      "MIPS": "mips",
      "MIPS64": "mips64",
      "X86_32": "x86-32",
      "X86_64": "x86-64"
    },
    "PlatformNaclArch": {
      "ARM": "arm",
      "MIPS": "mips",
      "MIPS64": "mips64",
      "X86_32": "x86-32",
      "X86_64": "x86-64"
    },
    "PlatformOs": {
      "ANDROID": "android",
      "CROS": "cros",
      "LINUX": "linux",
      "MAC": "mac",
      "OPENBSD": "openbsd",
      "WIN": "win"
    },
    "RequestUpdateCheckStatus": {
      "NO_UPDATE": "no_update",
      "THROTTLED": "throttled",
      "UPDATE_AVAILABLE": "update_available"
    }
  }
  if (!window.chrome) {
    Object.defineProperty(window, 'chrome', {
      writable: true,
      enumerable: true,
      configurable: false,
      value: {}
    })
  }
  const existsAlready = 'runtime' in window.chrome
  const isNotSecure = !window.location.protocol.startsWith('https')
  if (existsAlready || (isNotSecure && !runOnInsecureOrigins)) {
    return
  }
  window.chrome.runtime = {
    ...STATIC_DATA,
    get id() {
      return undefined
    },
    connect: null,
    sendMessage: null
  }
  const makeCustomRuntimeErrors = (preamble, method, extensionId) => ({
    NoMatchingSignature: new TypeError(
      preamble + `No matching signature.`
    ),
    MustSpecifyExtensionID: new TypeError(
      preamble +
      `${method} called from a webpage must specify an Extension ID (string) for its first argument.`
    ),
    InvalidExtensionID: new TypeError(
      preamble + `Invalid extension id: '${extensionId}'`
    )
  })
  const isValidExtensionID = str =>
    str.length === 32 && str.toLowerCase().match(/^[a-p]+$/)
  const sendMessageHandler = {
    apply: function (target, ctx, args) {
      const [extensionId, options, responseCallback] = args || []
      const errorPreamble = `Error in invocation of runtime.sendMessage(optional string extensionId, any message, optional object options, optional function responseCallback): `
      const Errors = makeCustomRuntimeErrors(
        errorPreamble,
        `chrome.runtime.sendMessage()`,
        extensionId
      )
      const noArguments = args.length === 0
      const tooManyArguments = args.length > 4
      const incorrectOptions = options && typeof options !== 'object'
      const incorrectResponseCallback =
        responseCallback && typeof responseCallback !== 'function'
      if (
        noArguments ||
        tooManyArguments ||
        incorrectOptions ||
        incorrectResponseCallback
      ) {
        throw Errors.NoMatchingSignature
      }
      if (args.length < 2) {
        throw Errors.MustSpecifyExtensionID
      }
      if (typeof extensionId !== 'string') {
        throw Errors.NoMatchingSignature
      }
      if (!isValidExtensionID(extensionId)) {
        throw Errors.InvalidExtensionID
      }
      return undefined
    }
  }
  utils.mockWithProxy(
    window.chrome.runtime,
    'sendMessage',
    function sendMessage() { },
    sendMessageHandler
  )
  const connectHandler = {
    apply: function (target, ctx, args) {
      const [extensionId, connectInfo] = args || []
      const errorPreamble = `Error in invocation of runtime.connect(optional string extensionId, optional object connectInfo): `
      const Errors = makeCustomRuntimeErrors(
        errorPreamble,
        `chrome.runtime.connect()`,
        extensionId
      )
      const noArguments = args.length === 0
      const emptyStringArgument = args.length === 1 && extensionId === ''
      if (noArguments || emptyStringArgument) {
        throw Errors.MustSpecifyExtensionID
      }
      const tooManyArguments = args.length > 2
      const incorrectConnectInfoType =
        connectInfo && typeof connectInfo !== 'object'
      if (tooManyArguments || incorrectConnectInfoType) {
        throw Errors.NoMatchingSignature
      }
      const extensionIdIsString = typeof extensionId === 'string'
      if (extensionIdIsString && extensionId === '') {
        throw Errors.MustSpecifyExtensionID
      }
      if (extensionIdIsString && !isValidExtensionID(extensionId)) {
        throw Errors.InvalidExtensionID
      }
      const validateConnectInfo = ci => {
        if (args.length > 1) {
          throw Errors.NoMatchingSignature
        }
        if (Object.keys(ci).length === 0) {
          throw Errors.MustSpecifyExtensionID
        }
        Object.entries(ci).forEach(([k, v]) => {
          const isExpected = ['name', 'includeTlsChannelId'].includes(k)
          if (!isExpected) {
            throw new TypeError(
              errorPreamble + `Unexpected property: '${k}'.`
            )
          }
          const MismatchError = (propName, expected, found) =>
            TypeError(
              errorPreamble +
              `Error at property '${propName}': Invalid type: expected ${expected}, found ${found}.`
            )
          if (k === 'name' && typeof v !== 'string') {
            throw MismatchError(k, 'string', typeof v)
          }
          if (k === 'includeTlsChannelId' && typeof v !== 'boolean') {
            throw MismatchError(k, 'boolean', typeof v)
          }
        })
      }
      if (typeof extensionId === 'object') {
        validateConnectInfo(extensionId)
        throw Errors.MustSpecifyExtensionID
      }
      return utils.patchToStringNested(makeConnectResponse())
    }
  }
  utils.mockWithProxy(
    window.chrome.runtime,
    'connect',
    function connect() { },
    connectHandler
  )
  function makeConnectResponse() {
    const onSomething = () => ({
      addListener: function addListener() { },
      dispatch: function dispatch() { },
      hasListener: function hasListener() { },
      hasListeners: function hasListeners() {
        return false
      },
      removeListener: function removeListener() { }
    })
    const response = {
      name: '',
      sender: undefined,
      disconnect: function disconnect() { },
      onDisconnect: onSomething(),
      onMessage: onSomething(),
      postMessage: function postMessage() {
        if (!arguments.length) {
          throw new TypeError(`Insufficient number of arguments.`)
        }
        throw new Error(`Attempting to use a disconnected port object`)
      }
    }
    return response
  }
}
''',
    'iframe.contentWindow.js': r'''
() => {
  try {
    const addContentWindowProxy = iframe => {
      const contentWindowProxy = {
        get(target, key) {
          if (key === 'self') {
            return this
          }
          if (key === 'frameElement') {
            return iframe
          }
          return Reflect.get(target, key)
        }
      }
      if (!iframe.contentWindow) {
        const proxy = new Proxy(window, contentWindowProxy)
        Object.defineProperty(iframe, 'contentWindow', {
          get() {
            return proxy
          },
          set(newValue) {
            return newValue
          },
          enumerable: true,
          configurable: false
        })
      }
    }
    const handleIframeCreation = (target, thisArg, args) => {
      const iframe = target.apply(thisArg, args)
      const _iframe = iframe
      const _srcdoc = _iframe.srcdoc
      Object.defineProperty(iframe, 'srcdoc', {
        configurable: true,
        get: function () {
          return _iframe.srcdoc
        },
        set: function (newValue) {
          addContentWindowProxy(this)
          Object.defineProperty(iframe, 'srcdoc', {
            configurable: false,
            writable: false,
            value: _srcdoc
          })
          _iframe.srcdoc = newValue
        }
      })
      return iframe
    }
    const addIframeCreationSniffer = () => {
      const createElement = {
        get(target, key) {
          return Reflect.get(target, key)
        },
        apply: function (target, thisArg, args) {
          const isIframe =
            args && args.length && `${args[0]}`.toLowerCase() === 'iframe'
          if (!isIframe) {
            return target.apply(thisArg, args)
          } else {
            return handleIframeCreation(target, thisArg, args)
          }
        }
      }
      document.createElement = new Proxy(
        document.createElement,
        createElement
      )
    }
    addIframeCreationSniffer()
  } catch (err) {
  }
}
''',
    'media.codecs.js': r'''
() => {
  const parseInput = arg => {
    const [mime, codecStr] = arg.trim().split(';')
    let codecs = []
    if (codecStr && codecStr.includes('codecs="')) {
      codecs = codecStr
        .trim()
        .replace(`codecs="`, '')
        .replace(`"`, '')
        .trim()
        .split(',')
        .filter(x => !!x)
        .map(x => x.trim())
    }
    return {
      mime,
      codecStr,
      codecs
    }
  }
  const canPlayType = {
    apply: function (target, ctx, args) {
      if (!args || !args.length) {
        return target.apply(ctx, args)
      }
      const { mime, codecs } = parseInput(args[0])
      if (mime === 'video/mp4') {
        if (codecs.includes('avc1.42E01E')) {
          return 'probably'
        }
      }
      if (mime === 'audio/x-m4a' && !codecs.length) {
        return 'maybe'
      }
      if (mime === 'audio/aac' && !codecs.length) {
        return 'probably'
      }
      return target.apply(ctx, args)
    }
  }
  utils.replaceWithProxy(
    HTMLMediaElement.prototype,
    'canPlayType',
    canPlayType
  )
}
''',
    'navigator.languages.js': r'''
(languages) => {
  Object.defineProperty(Object.getPrototypeOf(navigator), 'languages', {
    get: () => languages || ['en-US', 'en']
  })
}
''',
    'navigator.permissions.js': r'''
() => {
  const handler = {
    apply: function (target, ctx, args) {
      const param = (args || [])[0]
      if (param && param.name && param.name === 'notifications') {
        const result = { state: Notification.permission }
        Object.setPrototypeOf(result, PermissionStatus.prototype)
        return Promise.resolve(result)
      }
      return utils.cache.Reflect.apply(...arguments)
    }
  }
  utils.replaceWithProxy(
    window.navigator.permissions.__proto__,
    'query',
    handler
  )
}
''',
    'navigator.plugins.js': r'''
() => {
  const fns = {};
  fns.generatePluginArray = (utils, fns) => pluginsData => {
    return fns.generateMagicArray(utils, fns)(
      pluginsData,
      PluginArray.prototype,
      Plugin.prototype,
      'name'
    )
  }
  fns.generateFunctionMocks = utils => (
    proto,
    itemMainProp,
    dataArray
  ) => ({
    item: utils.createProxy(proto.item, {
      apply(target, ctx, args) {
        if (!args.length) {
          throw new TypeError(
            `Failed to execute 'item' on '${proto[Symbol.toStringTag]
            }': 1 argument required, but only 0 present.`
          )
        }
        const isInteger = args[0] && Number.isInteger(Number(args[0]))
        return (isInteger ? dataArray[Number(args[0])] : dataArray[0]) || null
      }
    }),
    namedItem: utils.createProxy(proto.namedItem, {
      apply(target, ctx, args) {
        if (!args.length) {
          throw new TypeError(
            `Failed to execute 'namedItem' on '${proto[Symbol.toStringTag]
            }': 1 argument required, but only 0 present.`
          )
        }
        return dataArray.find(mt => mt[itemMainProp] === args[0]) || null
      }
    }),
    refresh: proto.refresh
      ? utils.createProxy(proto.refresh, {
        apply(target, ctx, args) {
          return undefined
        }
      })
      : undefined
  })
  fns.generateMagicArray = (utils, fns) =>
    function (
      dataArray = [],
      proto = MimeTypeArray.prototype,
      itemProto = MimeType.prototype,
      itemMainProp = 'type'
    ) {
      const defineProp = (obj, prop, value) =>
        Object.defineProperty(obj, prop, {
          value,
          writable: false,
          enumerable: false,
          configurable: false
        })
      const makeItem = data => {
        const item = {}
        for (const prop of Object.keys(data)) {
          if (prop.startsWith('__')) {
            continue
          }
          defineProp(item, prop, data[prop])
        }
        return Object.create(itemProto, Object.getOwnPropertyDescriptors(item))
      }
      const magicArray = []
      dataArray.forEach(data => {
        magicArray.push(makeItem(data))
      })
      magicArray.forEach(entry => {
        defineProp(magicArray, entry[itemMainProp], entry)
      })
      const magicArrayObj = Object.create(proto, {
        ...Object.getOwnPropertyDescriptors(magicArray),
        length: {
          value: magicArray.length,
          writable: false,
          enumerable: false,
          configurable: true
        }
      })
      const functionMocks = fns.generateFunctionMocks(utils)(
        proto,
        itemMainProp,
        magicArray
      )
      const magicArrayObjProxy = new Proxy(magicArrayObj, {
        get(target, key = '') {
          if (key === 'item') {
            return functionMocks.item
          }
          if (key === 'namedItem') {
            return functionMocks.namedItem
          }
          if (proto === PluginArray.prototype && key === 'refresh') {
            return functionMocks.refresh
          }
          return utils.cache.Reflect.get(...arguments)
        },
        ownKeys(target) {
          const keys = []
          const typeProps = magicArray.map(mt => mt[itemMainProp])
          typeProps.forEach((_, i) => keys.push(`${i}`))
          typeProps.forEach(propName => keys.push(propName))
          return keys
        }
      })
      return magicArrayObjProxy
    }
  fns.generateMimeTypeArray = (utils, fns) => mimeTypesData => {
    return fns.generateMagicArray(utils, fns)(
      mimeTypesData,
      MimeTypeArray.prototype,
      MimeType.prototype,
      'type'
    )
  }
  const data = {
    "mimeTypes": [
      {
        "type": "application/pdf",
        "suffixes": "pdf",
        "description": "",
        "__pluginName": "Chrome PDF Viewer"
      },
      {
        "type": "application/x-google-chrome-pdf",
        "suffixes": "pdf",
        "description": "Portable Document Format",
        "__pluginName": "Chrome PDF Plugin"
      },
      {
        "type": "application/x-nacl",
        "suffixes": "",
        "description": "Native Client Executable",
        "__pluginName": "Native Client"
      },
      {
        "type": "application/x-pnacl",
        "suffixes": "",
        "description": "Portable Native Client Executable",
        "__pluginName": "Native Client"
      }
    ],
    "plugins": [
      {
        "name": "Chrome PDF Plugin",
        "filename": "internal-pdf-viewer",
        "description": "Portable Document Format",
        "__mimeTypes": ["application/x-google-chrome-pdf"]
      },
      {
        "name": "Chrome PDF Viewer",
        "filename": "mhjfbmdgcfjbbpaeojofohoefgiehjai",
        "description": "",
        "__mimeTypes": ["application/pdf"]
      },
      {
        "name": "Native Client",
        "filename": "internal-nacl-plugin",
        "description": "",
        "__mimeTypes": ["application/x-nacl", "application/x-pnacl"]
      }
    ]
  };
  const hasPlugins = 'plugins' in navigator && navigator.plugins.length
  if (hasPlugins) {
    return
  }
  const mimeTypes = fns.generateMimeTypeArray(utils, fns)(data.mimeTypes)
  const plugins = fns.generatePluginArray(utils, fns)(data.plugins)
  for (const pluginData of data.plugins) {
    pluginData.__mimeTypes.forEach((type, index) => {
      plugins[pluginData.name][index] = mimeTypes[type]
      plugins[type] = mimeTypes[type]
      Object.defineProperty(mimeTypes[type], 'enabledPlugins', {
        value: JSON.parse(JSON.stringify(plugins[pluginData.name])),
        writable: false,
        enumerable: false,
        configurable: false
      })
    })
  }
  const patchNavigator = (name, value) =>
    utils.replaceProperty(Object.getPrototypeOf(navigator), name, {
      get() {
        return value
      }
    })
  patchNavigator('mimeTypes', mimeTypes)
  patchNavigator('plugins', plugins)
}
''',
    'navigator.vendor.js': r'''
vendor => {
  Object.defineProperty(Object.getPrototypeOf(navigator), 'vendor', {
    get: () => vendor || 'Google Inc.'
  })
}
''',
    'navigator.webdriver.js': r'''
() => {
  delete Object.getPrototypeOf(navigator).webdriver
}
''',
    'webgl.vendor.js': r'''
(vendor, renderer) => {
  const getParameterProxyHandler = {
    apply: function (target, ctx, args) {
      const param = (args || [])[0]
      if (param === 37445) {
        return vendor || 'Intel Inc.'
      }
      if (param === 37446) {
        return renderer || 'Intel Iris OpenGL Engine'
      }
      return utils.cache.Reflect.apply(target, ctx, args)
    }
  }
  const addProxy = (obj, propName) => {
    utils.replaceWithProxy(obj, propName, getParameterProxyHandler)
  }
  addProxy(WebGLRenderingContext.prototype, 'getParameter')
  addProxy(WebGL2RenderingContext.prototype, 'getParameter')
}
''',
    'window.outerdimensions.js': r'''
() => {
  try {
    if (window.outerWidth && window.outerHeight) {
      return
    }
    const windowFrame = 85
    window.outerWidth = window.innerWidth
    window.outerHeight = window.innerHeight + windowFrame
  } catch (err) { }
}
''',
}

os.environ.setdefault('OPENSSL_LEGACY_SERVER_CONNECT', '1')

_is_test = '--test' in sys.argv
_is_init = '--init' in sys.argv
_is_rebuild_stats = '--rebuild-stats' in sys.argv
_is_deploy_frontend = '--deploy-frontend' in sys.argv

_carrier_ctx = threading.local()


class _CarrierLogFilter(logging.Filter):
    def filter(self, record):
        record.carrier = getattr(_carrier_ctx, 'carrier', '系统')
        return True


_log_level = logging.DEBUG if _is_test else logging.INFO
logging.basicConfig(level=_log_level, format='[%(asctime)s] [%(levelname)s] [%(carrier)s] %(message)s', datefmt='%Y/%m/%d %H:%M:%S')
_root = logging.getLogger()
_root.setLevel(_log_level)
for _h in _root.handlers:
    _h.setLevel(_log_level)
    _h.addFilter(_CarrierLogFilter())
logger = logging.getLogger('cmcc')
logger.setLevel(_log_level)

logging.getLogger('urllib3').setLevel(logging.WARNING)
logging.getLogger('urllib3.connectionpool').setLevel(logging.ERROR)

_active_apis = []


# ════════════════════════════════════════════════════════════
#  常量与映射
# ════════════════════════════════════════════════════════════

CARRIER_CATEGORY_MAPS = {}


def _get_attr_label(carrier, code):
    m = CARRIER_CATEGORY_MAPS.get(carrier, {})
    return m.get('attr', {}).get(code, code)


def _get_t1_label(carrier, code):
    m = CARRIER_CATEGORY_MAPS.get(carrier, {})
    return m.get('t1', {}).get(code, code)


def _get_t2_label(carrier, code):
    m = CARRIER_CATEGORY_MAPS.get(carrier, {})
    return m.get('t2', {}).get(code, code)


DEFAULT_CATEGORY_MAPS = {
    'cmcc': {
        'attr': {'1': '全网资费', '2': '本省资费', '3': '家庭资费'},
        't1': {'1': '个人资费', '2': '政企资费'},
        't2': {'1': '套餐', '2': '加装包', '3': '营销活动', '4': '其他'},
    },
    'cucc': {
        'attr': {'1': '全网资费', '2': '本省资费', '3': '家庭资费'},
        't1': {'1': '个人资费', '2': '政企资费'},
        't2': {'1': '套餐', '2': '加装包', '3': '营销活动', '4': '其他'},
    },
    'ctcc': {
        'attr': {'1': '全网资费', '2': '本省资费', '3': '家庭资费'},
        't1': {'1': '个人资费', '2': '政企资费'},
        't2': {'1': '套餐', '2': '加装包', '3': '营销活动', '4': '其他'},
    },
    'cbn': {
        'attr': {'1': '全网资费', '2': '本省资费', '3': '家庭资费'},
        't1': {'1': '个人资费', '2': '政企资费'},
        't2': {'1': '套餐', '2': '加装包', '3': '营销活动', '4': '其他'},
    },
}

FIELD_KEYS = [
    '方案编号', '产品名称', '资费类型', '归属', '产品编码',
    '资费标准', '产品价格', '价格单位', '上线日期', '下线日期',
    '有效期限', '在网要求', '适用范围', '适用地区', '销售渠道',
    '退订方式', '违约责任', '互斥规则', '到期规则', '入网要求',
    '国内通话', '国内通用流量', '定向流量', '区域流量', '宽带',
    '移动高清', '短信', '亲情网', '权益', '超出资费说明',
    '额外费用', '其他费用', '资费说明', '其他服务内容', '办理说明',
    '其他说明', '状态', '更新时间', '创建时间',
]

EXTRA_FIELD_KEYS = {
    'cmcc': [],
    'cucc': [],
    'ctcc': [
        'lable1Name', 'lable1Id',
        'jbxx_html', 'ffnr_html',
    ],
    'cbn': [
        'type1', 'type2', 'parentTypeCode', 'parentTypeGrade',
        'applicableArea', 'reserveStr1', 'reserveStr2', 'reserveStr3',
    ],
}

PROVINCES = [
    {'name': '北京市', 'code': 'bj', 'cmccCode': '100', 'cuccCode': '011', 'cuccCityCode': '110', 'ctccCode': '609001', 'cityCode': 'bj', 'cbnCode': 'BJ00'},
    {'name': '天津市', 'code': 'tj', 'cmccCode': '220', 'cuccCode': '013', 'cuccCityCode': '130', 'ctccCode': '609902', 'cityCode': 'tj', 'cbnCode': 'TJ00'},
    {'name': '河北省', 'code': 'he', 'cmccCode': '311', 'cuccCode': '018', 'cuccCityCode': '180', 'ctccCode': '609906', 'cityCode': 'he', 'cbnCode': '0311'},
    {'name': '山西省', 'code': 'sx', 'cmccCode': '351', 'cuccCode': '019', 'cuccCityCode': '190', 'ctccCode': '609907', 'cityCode': 'sx', 'cbnCode': 'SX01'},
    {'name': '内蒙古', 'code': 'nmg', 'cmccCode': '471', 'cuccCode': '010', 'cuccCityCode': '101', 'ctccCode': '609908', 'cityCode': 'nm', 'cbnCode': '0471'},
    {'name': '辽宁省', 'code': 'ln', 'cmccCode': '240', 'cuccCode': '091', 'cuccCityCode': '910', 'ctccCode': '609905', 'cityCode': 'ln', 'cbnCode': 'LN00'},
    {'name': '吉林省', 'code': 'jl', 'cmccCode': '431', 'cuccCode': '090', 'cuccCityCode': '901', 'ctccCode': '609909', 'cityCode': 'jl', 'cbnCode': 'JL00'},
    {'name': '黑龙江省', 'code': 'hlj', 'cmccCode': '451', 'cuccCode': '097', 'cuccCityCode': '971', 'ctccCode': '609910', 'cityCode': 'hl', 'cbnCode': '0451'},
    {'name': '上海市', 'code': 'sh', 'cmccCode': '210', 'cuccCode': '031', 'cuccCityCode': '310', 'ctccCode': '600102', 'cityCode': 'sh', 'cbnCode': 'SH00'},
    {'name': '江苏省', 'code': 'js', 'cmccCode': '250', 'cuccCode': '034', 'cuccCityCode': '330', 'ctccCode': '600103', 'cityCode': 'js', 'cbnCode': 'JS00'},
    {'name': '浙江省', 'code': 'zj', 'cmccCode': '571', 'cuccCode': '036', 'cuccCityCode': '360', 'ctccCode': '600104', 'cityCode': 'zj', 'cbnCode': 'ZJ00'},
    {'name': '安徽省', 'code': 'ah', 'cmccCode': '551', 'cuccCode': '030', 'cuccCityCode': '300', 'ctccCode': '600301', 'cityCode': 'ah', 'cbnCode': 'AH00'},
    {'name': '福建省', 'code': 'fj', 'cmccCode': '591', 'cuccCode': '038', 'cuccCityCode': '380', 'ctccCode': '600105', 'cityCode': 'fj', 'cbnCode': 'FJ00'},
    {'name': '江西省', 'code': 'jx', 'cmccCode': '791', 'cuccCode': '075', 'cuccCityCode': '740', 'ctccCode': '600305', 'cityCode': 'jx', 'cbnCode': 'JX00'},
    {'name': '山东省', 'code': 'sd', 'cmccCode': '531', 'cuccCode': '017', 'cuccCityCode': '150', 'ctccCode': '609903', 'cityCode': 'sd', 'cbnCode': 'SD00'},
    {'name': '河南省', 'code': 'hn', 'cmccCode': '371', 'cuccCode': '076', 'cuccCityCode': '760', 'ctccCode': '609904', 'cityCode': 'ha', 'cbnCode': 'HN00'},
    {'name': '湖北省', 'code': 'hub', 'cmccCode': '270', 'cuccCode': '071', 'cuccCityCode': '710', 'ctccCode': '600202', 'cityCode': 'hb', 'cbnCode': 'HB00'},
    {'name': '湖南省', 'code': 'hun', 'cmccCode': '731', 'cuccCode': '074', 'cuccCityCode': '741', 'ctccCode': '600203', 'cityCode': 'hn', 'cbnCode': 'HN00'},
    {'name': '广东省', 'code': 'gd', 'cmccCode': '200', 'cuccCode': '051', 'cuccCityCode': '510', 'ctccCode': '600101', 'cityCode': 'gd', 'cbnCode': 'GD00'},
    {'name': '广西', 'code': 'gx', 'cmccCode': '771', 'cuccCode': '059', 'cuccCityCode': '588', 'ctccCode': '600302', 'cityCode': 'gx', 'cbnCode': 'GX00'},
    {'name': '海南省', 'code': 'han', 'cmccCode': '898', 'cuccCode': '050', 'cuccCityCode': '501', 'ctccCode': '600403', 'cityCode': 'hi', 'cbnCode': '898'},
    {'name': '重庆市', 'code': 'cq', 'cmccCode': '230', 'cuccCode': '083', 'cuccCityCode': '831', 'ctccCode': '600304', 'cityCode': 'cq', 'cbnCode': 'CQ00'},
    {'name': '四川省', 'code': 'sc', 'cmccCode': '280', 'cuccCode': '081', 'cuccCityCode': '810', 'ctccCode': '600201', 'cityCode': 'sc', 'cbnCode': 'SC00'},
    {'name': '贵州省', 'code': 'gz', 'cmccCode': '851', 'cuccCode': '085', 'cuccCityCode': '785', 'ctccCode': '600402', 'cityCode': 'gz', 'cbnCode': 'GZ01'},
    {'name': '云南省', 'code': 'yn', 'cmccCode': '871', 'cuccCode': '086', 'cuccCityCode': '730', 'ctccCode': '600205', 'cityCode': 'yn', 'cbnCode': 'YN00'},
    {'name': '西藏', 'code': 'xz', 'cmccCode': '891', 'cuccCode': '079', 'cuccCityCode': '790', 'ctccCode': '600406', 'cityCode': 'xz', 'cbnCode': 'XZ00'},
    {'name': '陕西省', 'code': 'snx', 'cmccCode': '290', 'cuccCode': '084', 'cuccCityCode': '840', 'ctccCode': '600204', 'cityCode': 'sn', 'cbnCode': 'SX00'},
    {'name': '甘肃省', 'code': 'gs', 'cmccCode': '931', 'cuccCode': '087', 'cuccCityCode': '870', 'ctccCode': '600401', 'cityCode': 'gs', 'cbnCode': 'GS00'},
    {'name': '青海省', 'code': 'qh', 'cmccCode': '971', 'cuccCode': '070', 'cuccCityCode': '700', 'ctccCode': '600405', 'cityCode': 'qh', 'cbnCode': 'QH00'},
    {'name': '宁夏', 'code': 'nx', 'cmccCode': '951', 'cuccCode': '088', 'cuccCityCode': '880', 'ctccCode': '600404', 'cityCode': 'nx', 'cbnCode': 'NX00'},
    {'name': '新疆', 'code': 'xj', 'cmccCode': '991', 'cuccCode': '089', 'cuccCityCode': '890', 'ctccCode': '600303', 'cityCode': 'xj', 'cbnCode': 'XJ00'},
    {'name': '全网', 'code': 'quanguo', 'cmccCode': '', 'cuccCode': '', 'cuccCityCode': '', 'ctccCode': '', 'cityCode': '', 'cbnCode': 'ZZZZ'},
    {'name': '深圳', 'code': 'sz', 'cmccCode': '', 'cuccCode': '', 'cuccCityCode': '', 'ctccCode': '', 'cityCode': 'sz', 'cbnCode': 'SZ00'},
]

PROVINCE_BY_CODE = {p['code']: p for p in PROVINCES}
PROVINCE_BY_CMCC = {p['cmccCode']: p for p in PROVINCES}
PROVINCE_BY_CUCC = {p['cuccCode']: p for p in PROVINCES}
PROVINCE_BY_CTCC = {p['ctccCode']: p for p in PROVINCES}
PROVINCE_BY_CBN = {p['cbnCode']: p for p in PROVINCES}


# ════════════════════════════════════════════════════════════
#  UA 池 (60 个纯移动端 User-Agent)
# ════════════════════════════════════════════════════════════

UA_POOL = [
    # --- Samsung (8) ---
    'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; SM-S9210) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; SM-A346B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 12; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 12; SM-G996B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0 Mobile Safari/537.36',
    # --- Huawei (7) ---
    'Mozilla/5.0 (Linux; Android 14; ELE-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; ALT-AL10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 12; NOH-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 12; VOG-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; FOA-AL10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; HMA-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; TAS-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Mobile Safari/537.36',
    # --- Xiaomi (7) ---
    'Mozilla/5.0 (Linux; Android 14; 23127PN0BC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; 2211133C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; 24012PC0C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; 23013RK75C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; 2210132C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 12; 2201123C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; M2012K11AC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0 Mobile Safari/537.36',
    # --- OPPO (5) ---
    'Mozilla/5.0 (Linux; Android 14; PHB110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; CPH2461) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; CPH2591) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; PHT110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; A3 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Mobile Safari/537.36',
    # --- vivo (5) ---
    'Mozilla/5.0 (Linux; Android 14; V2324A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; V2231A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; V2338A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; V2219A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; V2247A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Mobile Safari/537.36',
    # --- Google Pixel (5) ---
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 12; Pixel 6a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0 Mobile Safari/537.36',
    # --- OnePlus (4) ---
    'Mozilla/5.0 (Linux; Android 14; PJK110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; IN2020) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; LE2120) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 12; LE2110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0 Mobile Safari/537.36',
    # --- Honor (4) ---
    'Mozilla/5.0 (Linux; Android 14; BVL4-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; ALA-AN70) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; MAA-AN10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 12; ELZ-AN10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Mobile Safari/537.36',
    # --- Realme (3) ---
    'Mozilla/5.0 (Linux; Android 14; RMX3888) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; RMX3710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; RMX3688) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Mobile Safari/537.36',
    # --- iPhone (12) ---
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.7 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.8 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.7 Mobile/15E148 Safari/604.1',
]

_ua_idx = 0
_ua_lock = threading.Lock()


def _pick_ua(pool=None):
    global _ua_idx
    use_pool = pool if pool else UA_POOL
    with _ua_lock:
        idx = _ua_idx
        _ua_idx += 1
    return use_pool[idx % len(use_pool)]


# ════════════════════════════════════════════════════════════
#  配置解析与验证
# ════════════════════════════════════════════════════════════

DEFAULT_FIXED_CATEGORIES = []
for _fa in ('1', '2', '3'):
    for _ft1 in ('1', '2'):
        for _ft2 in ('1', '2', '3', '4'):
            DEFAULT_FIXED_CATEGORIES.append({'tariffAttr': _fa, 'type1': _ft1, 'type2': _ft2})

CUCC_FIXED_CATEGORIES = []
_cucc_first_map = {'1': '1', '2': '2', '3': '3', '4': '4', '5': '4', '99': '4'}
_cucc_seconds = {
    '1': ['1001', '1002', '1003', '1004'],
    '2': ['2001', '2002', '2003', '2004', '2005', '2006'],
    '3': ['3001', '3002'],
    '4': ['4001', '4002', '4003', '4004'],
    '5': ['5001'],
    '99': ['1', '2', '3', '4', '5'],
}
for _first, _t2 in _cucc_first_map.items():
    for _second in _cucc_seconds[_first]:
        for _attr in ('1', '2'):
            CUCC_FIXED_CATEGORIES.append({
                'tariffAttr': _attr, 'type1': '1', 'type2': _t2,
                '_cucc_first': _first, '_cucc_second': _second,
            })

CTCC_FIXED_CATEGORIES = [
    {'tariffAttr': '1', 'type1': '1', 'type2': '1', '_ctcc_lable1Id': '1'},
    {'tariffAttr': '1', 'type1': '1', 'type2': '2', '_ctcc_lable1Id': '2'},
    {'tariffAttr': '1', 'type1': '1', 'type2': '3', '_ctcc_lable1Id': '3'},
]

CBN_FIXED_CATEGORIES = [
    {'tariffAttr': '1', 'type1': '1', 'type2': '1', '_cbn_type1': 'GZ', '_cbn_type2': '', '_cbn_type3': ''},
    {'tariffAttr': '1', 'type1': '2', 'type2': '1', '_cbn_type1': 'ZQ', '_cbn_type2': '', '_cbn_type3': ''},
]

CARRIER_FIXED_CATEGORIES = {
    'cmcc': DEFAULT_FIXED_CATEGORIES,
    'cucc': CUCC_FIXED_CATEGORIES,
    'ctcc': CTCC_FIXED_CATEGORIES,
    'cbn': CBN_FIXED_CATEGORIES,
}

CARRIER_DISPLAY_NAMES = {
    'cmcc': '中国移动',
    'cucc': '中国联通',
    'ctcc': '中国电信',
    'cbn': '中国广电',
}


# ════════════════════════════════════════════════════════════
#  数据结构版本号
#  说明：标识 snapshot/stats/changelog 三类 JSON 数据的结构版本。
#  变更版本号时，必须同时更新：
#    1. 本文件中的对应常量
#    2. 同目录下对应 schema 文件中的 "const" 字段（保持一致）
#  前端仅透传 version，不据此做兼容性分支。
# ════════════════════════════════════════════════════════════
SNAPSHOT_VERSION = 4
CHANGELOG_VERSION = 4
STATS_VERSION = 7


def carrier_display(carrier_key):
    name = CARRIER_DISPLAY_NAMES.get(carrier_key, carrier_key)
    return f'{name}（{carrier_key}）'


DEFAULT_CONFIG = {
    'storage': {
        # 多通道部署：primary = 容灾第一优先 + 旧数据基线读取来源；
        # backends 各线 enabled 开关任意组合，commit 遍历启用线逐个推送（单线失败仅告警）。
        # 兼容旧单 type 格式（type: 'cloudflare' + 顶层 cloudflare/github 键）。
        'primary': 'cloudflare',
        'backends': {
            'cloudflare': {
                'enabled': True,
                'account_id': '',
                'project_name': '',
                'api_token': '',
                'domain': '',
                'path': 'data',
                'include_frontend': True,
                'frontend_dir': './pages-dist',
            },
            'edgeone': {
                'enabled': False,
                'project_name': '',
                'api_token': '',   # Pages 控制台 Settings → API Token（账号级，入青龙环境变量，严禁入库）
                'domain': '',      # 自定义域（必填：读取基线 + 容灾清单来源）
                'cli': 'edgeone',  # CLI 可执行名（环境需 node + npm i -g edgeone，版本≥1.2.30）
                'deploy_timeout': 600,
                'path': 'data',
                'include_frontend': True,
                'frontend_dir': './pages-dist',
            },
            'github': {
                'enabled': False,
                'token': '',
                'repo': '',
                'branch': 'main',
                'path': 'data',
                'domain': '',        # 自定义域（多线下必填；同时用于容灾清单）
                'cname_file': False, # 启用 GitHub Pages 自定义域时置 true：随站点根提交 CNAME 文件
                'include_frontend': True,
                'frontend_dir': './pages-dist',
            },
        },
        'cache': {
            'ttl_minutes': 30,
        },
        'local_cache': {
            'enabled': False,
            'path': '',
        },
        'manifest_cache': {
            'enabled': True,
        },
        'frontend_source': {
            # 前端文件来源（三线共用）：github_prefer=优先 GitHub（默认；部署前拉取最新，失败回落本地，仅告警不中断）；
            #   local_only=仅本地目录（不做任何拉取）；
            #   local_prefer=优先本地（本地目录非空用本地，为空才拉取）；
            #   github_only=仅 GitHub（必须拉取成功，失败则本轮前端部署报错终止，防发布过期缓存）。
            # frontend_dir 为全局本地前端目录（读取源/缓存位置），优先级高于各线旧 frontend_dir 字段（历史遗留，仍兼容）。
            'mode': 'github_prefer',
            'frontend_dir': './pages-dist',
            'repo': '',            # 如 'user/repo'（前端文件所在仓库；非 local_only 模式必填）
            'branch': 'main',
            'subdir': 'pages-dist',  # 仓库内前端文件所在目录（zip 包内相对路径）
            'mirror_prefix': '',   # 可选 GitHub 加速镜像前缀（拼在完整 API URL 前），如 'https://ghfast.top/'
            'token': '',           # 可选：私有库访问令牌（公开库留空即可）
            'timeout_sec': 60,
        },
    },
    'crawl': {
        'pagination_mode': 'auto',
        'max_pages': 5,
        'page_size': 10000,
        'category_interval_ms': 8000,
        'page_interval_ms': 300,
        'retry_times': 3,
        'retry_base_ms': 1000,
        'retry_max_ms': 30000,
        'retry_jitter': 0.3,
        'delay_min': 60,
        'delay_max': 120,
        'jitter_ratio': 0.2,
        'ua_pool': [],
    },
    'volatility': {
        'threshold': 0.3,
        'threshold_sudden': 0.7,
        'surge_duplicate_threshold': 0.5,
        'degrade_auto_recover_threshold': 0,
    },
    'schedule': {
        'cron': '0 8 * * *',
        'interval_hours': 24,
        'concurrent_carriers': False,
        'max_workers': 4,
        'province_workers': 1,
    },
    'data_processing': {
        'filter_test': {
            'enabled': True,
            'patterns': [
                '测试', '作废', '废弃', '验证数据', '调试', '请勿', '请忽略',
                '勿参考', '不代表真实', 'test', 'demo', '样例', '示例',
                '内部专用', '压测', '联调',
            ],
            'exclude_patterns': [],
        },
        'html_strip_before_diff': True,
        'verify_fake_removed': {
            'enabled': True,
            'date_field': '下线日期',
            'logic': 'future_only',
            'stale_online_days': 2,
        },
        'structure_upgrade_detect': True,
    },
    'changelog': {
        'retention_days': 30,
    },
    'notification': {
        'types': {
            'change': True,
            'error': True,
            'degrade': True,
            'all_fail': True,
            'no_change': True,
        },
        'channels': {
            'ql_panel': True,
            'ext_msg': False,
        },
        # 采集播报统一工作目录（digest 文件 / coll_today / notify_dispatch.py 同目录）
        # 空 = 回退脚本自身所在目录；配置页「通知渠道」组「分发脚本目录」生成
        'digest_dir': '',
        # SMTP 发信邮箱池（配置页「SMTP 邮箱」页签生成）：本脚本不消费，
        # 随 TARIFF_CONFIG 注入青龙后由 notify_dispatch.py 读取（回退旧 SMTP_ACCOUNTS 环境变量）
        'smtp_accounts': [],
    },
    'carriers': {
        'cmcc': {
            'enabled': True,
            'default_province': 'hun',
            'provinces': [],
            'category_mode': 'dynamic',
            'fixed_categories': DEFAULT_FIXED_CATEGORIES,
            'category_maps': DEFAULT_CATEGORY_MAPS['cmcc'],
            'api': {
                'base_url': 'https://h.app.coc.10086.cn/website/',
                'app_url': 'https://h.app.coc.10086.cn/cmcc-app/',
                'page_url': 'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html',
                'aes_key': '1234123412ABCDEF',
                'aes_iv': 'ABCDEF1234123412',
            },
            'crawl': {
                'category_interval_ms': 8000,
                'delay_min': 60,
                'delay_max': 120,
            },
            'volatility': {
                'threshold': 0.3,
                'threshold_sudden': 0.7,
                'surge_duplicate_threshold': 0.5,
            },
            'notification': {
                'provinces': [],
            },
        },
        'cucc': {
            'enabled': False,
            'default_province': 'hun',
            'provinces': [],
            'category_mode': 'dynamic',
            'fixed_categories': CUCC_FIXED_CATEGORIES,
            'category_maps': DEFAULT_CATEGORY_MAPS['cucc'],
            'api': {
                'base_url': 'https://m.client.10010.com/servicequerybusiness',
                'app_url': 'https://img.client.10010.com/zifeizhuanquwt/',
                'page_url': 'https://img.client.10010.com/zifeizhuanquwt/index.html#/',
                'aes_key': '6b8b4567327b23c6643c527d5b8c8a17',
                'aes_iv': '',
            },
            'crawl': {},
            'volatility': {},
            'notification': {
                'provinces': [],
            },
        },
        'ctcc': {
            'enabled': False,
            'default_province': 'hun',
            'provinces': [],
            'category_mode': 'dynamic',
            'fixed_categories': CTCC_FIXED_CATEGORIES,
            'category_maps': DEFAULT_CATEGORY_MAPS['ctcc'],
            'api': {
                'base_url': 'https://www.189.cn/bss/tariffZone/',
                'app_url': 'https://www.189.cn/tariffZone/',
                'page_url': 'https://www.189.cn/tariffZone/',
                'aes_key': '',
                'aes_iv': '',
                'direct_api_url': 'https://www.189.cn/wapportalweb/wapportalweb/tariffSection.do',
                'direct_aes_key': 'telecom_wap_2018',
            },
            'crawl': {
                'direct_mode': 'prefer_direct',
                'category_interval_ms': 8000,
                'page_interval_ms': 2000,
                'retry_times': 5,
                'retry_base_ms': 3000,
                'retry_max_ms': 60000,
                'delay_min': 30,
                'delay_max': 90,
            },
            'volatility': {},
            'notification': {
                'provinces': [],
            },
        },
        'cbn': {
            'enabled': False,
            'default_province': 'hun',
            'provinces': [],
            'category_mode': 'dynamic',
            'fixed_categories': CBN_FIXED_CATEGORIES,
            'category_maps': DEFAULT_CATEGORY_MAPS['cbn'],
            'api': {
                'base_url': 'https://m.10099.com.cn/contact-web/api',
                'app_url': 'https://m.10099.com.cn/expensesNotice/',
                'page_url': 'https://m.10099.com.cn/expensesNotice/#/home',
                'aes_key': '',
                'aes_iv': '',
            },
            'crawl': {},
            'volatility': {},
            'notification': {
                'provinces': [],
            },
        },
    },
    'schema_version': '4',
    'default_carrier': 'cmcc',
}


# 配置合并：override 完全替换 base 的同键值（列表也不例外）。
# 设计意图：用户配置是全量覆盖，不是追加。例如用户指定 provinces=['hun','gd']，
# 意为"只采集这两个省份"，而非"在默认基础上追加"。追加会导致用户无法精确控制配置范围。
# 注：provinces/fixed_categories 在 get_carrier_config 中直接取值，不经过本函数。
# 注：注释仅供参考，代码功能可能改变，以实际逻辑为准。
def _deep_merge(base, override):
    result = dict(base)
    for k, v in override.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result


def parse_and_validate_config():
    raw = os.environ.get('TARIFF_CONFIG', '').strip()
    if not raw:
        config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')
        if os.path.exists(config_path):
            with open(config_path, 'r', encoding='utf-8') as f:
                raw = f.read()
            logger.info(f'从本地文件加载配置: {config_path}')
    if not raw:
        raise ValueError('未找到配置: 请设置环境变量 TARIFF_CONFIG 或提供 config.json 文件')

    try:
        user_config = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f'配置 JSON 语法错误: {e}')

    config = _deep_merge(DEFAULT_CONFIG, user_config)
    # 旧单 type 格式兼容：剔除 DEFAULT_CONFIG 注入的空模板 primary/backends，
    # 避免归一化时误用空凭证模板覆盖用户真实单线配置
    _user_sc = user_config.get('storage') or {}
    if not (isinstance(_user_sc.get('backends'), dict) or 'primary' in _user_sc):
        config['storage'].pop('backends', None)
        config['storage'].pop('primary', None)
    errors = []

    # 多通道 storage 校验：normalize 统一新格式（primary+backends）与旧单 type 格式，
    # 并把各线配置提升到 config['storage'][name]（进程内），逐启用线校验必填项
    try:
        _norm = normalize_storage_config(config)
    except ValueError as e:
        errors.append(f'storage: {e}')
        _norm = None
    if _norm:
        for _name in _norm['order']:
            _b = config['storage'].get(_name) or {}
            if _name == 'cloudflare':
                for k in ('account_id', 'project_name', 'api_token'):
                    if not _b.get(k):
                        errors.append(f'storage.backends.cloudflare.{k} 未配置')
                if not _b.get('domain'):
                    errors.append('storage.backends.cloudflare.domain 未配置（必须配置域名，否则无法读取旧数据做对比）')
            elif _name == 'github':
                for k in ('token', 'repo'):
                    if not _b.get(k):
                        errors.append(f'storage.backends.github.{k} 未配置')
                if not _b.get('domain'):
                    errors.append('storage.backends.github.domain 未配置（多线下必填：读取基线 + 容灾清单来源）')
            elif _name == 'edgeone':
                for k in ('project_name',):
                    if not _b.get(k):
                        errors.append(f'storage.backends.edgeone.{k} 未配置')
                if not _b.get('domain'):
                    errors.append('storage.backends.edgeone.domain 未配置（必填：读取基线 + 容灾清单来源）')
                # api_token 可空：本机 CLI 已登录时可用本地凭证；青龙等无浏览器环境必须填

    cache_ttl = config.get('storage', {}).get('cache', {}).get('ttl_minutes', 30)
    if not isinstance(cache_ttl, (int, float)) or cache_ttl < 0:
        errors.append('storage.cache.ttl_minutes 需为非负数')

    # 通知渠道 / 采集播报工作目录（轻校验：类型错误才拦截；路径不可用属运行时告警不阻断）
    _notif = config.get('notification', {})
    _ch = _notif.get('channels', {})
    if not isinstance(_ch, dict):
        errors.append('notification.channels 需为对象')
    else:
        for _ck in ('ql_panel', 'ext_msg'):
            if _ck in _ch and not isinstance(_ch[_ck], bool):
                errors.append(f'notification.channels.{_ck} 需为布尔值')
    _dd = _notif.get('digest_dir', '')
    if not isinstance(_dd, str):
        errors.append('notification.digest_dir 需为字符串（分发脚本所在目录，留空 = 脚本所在目录）')
    _sa = _notif.get('smtp_accounts', [])
    if not isinstance(_sa, list):
        errors.append('notification.smtp_accounts 需为数组')
    else:
        for _i, _a in enumerate(_sa):
            if not isinstance(_a, dict):
                errors.append(f'notification.smtp_accounts[{_i}] 需为对象')
                continue
            for _k in ('host', 'user', 'pass'):
                if not _a.get(_k):
                    errors.append(f'notification.smtp_accounts[{_i}].{_k} 缺失')
            _p = _a.get('port', 465)
            if not isinstance(_p, int) or not (1 <= _p <= 65535):
                errors.append(f'notification.smtp_accounts[{_i}].port 需为 1-65535 的整数')

    crawl = config['crawl']

    if crawl.get('pagination_mode') not in ('auto', 'bulk', 'page'):
        errors.append(f'crawl.pagination_mode 无效: {crawl.get("pagination_mode")}, 可选: auto/bulk/page')

    for key, lo, hi in [
        ('max_pages', 1, 20),
        ('retry_times', 1, 10),
        ('delay_min', 5, 600),
        ('delay_max', 5, 600),
        ('page_size', 100, 50000),
        ('category_interval_ms', 100, 30000),
        ('page_interval_ms', 50, 10000),
        ('retry_base_ms', 100, 60000),
        ('retry_max_ms', 1000, 600000),
    ]:
        v = crawl.get(key)
        if not isinstance(v, (int, float)) or v < lo or v > hi:
            errors.append(f'crawl.{key} 需在 {lo}-{hi} 之间, 当前: {v}')

    if crawl.get('delay_min', 0) >= crawl.get('delay_max', 1):
        errors.append('crawl.delay_min 必须小于 delay_max')

    if crawl.get('retry_base_ms', 0) >= crawl.get('retry_max_ms', 1):
        errors.append('crawl.retry_base_ms 必须小于 retry_max_ms')

    if not (0 <= crawl.get('retry_jitter', 0) <= 1):
        errors.append('crawl.retry_jitter 需在 0-1 之间')

    if not (0 <= crawl.get('jitter_ratio', 0) <= 1):
        errors.append('crawl.jitter_ratio 需在 0-1 之间')

    vol = config['volatility']
    if not (0 <= vol.get('threshold', 0) <= 1):
        errors.append('volatility.threshold 需在 0-1 之间')
    if not (0 <= vol.get('threshold_sudden', 0) <= 1):
        errors.append('volatility.threshold_sudden 需在 0-1 之间')
    if vol.get('threshold', 0) >= vol.get('threshold_sudden', 1):
        errors.append('volatility.threshold 必须小于 threshold_sudden')
    if not (0 <= vol.get('surge_duplicate_threshold', 0.5) <= 1):
        errors.append('volatility.surge_duplicate_threshold 需在 0-1 之间')
    dart = vol.get('degrade_auto_recover_threshold', 0)
    if not isinstance(dart, int) or dart < 0 or dart > 20:
        errors.append('volatility.degrade_auto_recover_threshold 需为 0-20 之间的整数')

    sched = config['schedule']
    if not isinstance(sched.get('interval_hours'), (int, float)) or sched['interval_hours'] < 1:
        errors.append('schedule.interval_hours 需 >= 1')

    cl = config['changelog']
    if not isinstance(cl.get('retention_days'), int) or cl['retention_days'] < 1:
        errors.append('changelog.retention_days 需 >= 1')

    dp = config.get('data_processing', {})
    vfr = dp.get('verify_fake_removed', {})
    if vfr.get('enabled', True):
        df = vfr.get('date_field', '下线日期')
        if df not in ('下线日期', '有效期限'):
            errors.append('data_processing.verify_fake_removed.date_field 需为 "下线日期" 或 "有效期限"')
        lg = vfr.get('logic', 'future_only')
        if lg not in ('future_only', 'future_and_today', 'disabled'):
            errors.append('data_processing.verify_fake_removed.logic 需为 future_only / future_and_today / disabled')
        sod = vfr.get('stale_online_days', 2)
        if not isinstance(sod, (int, float)) or sod < 1:
            errors.append('data_processing.verify_fake_removed.stale_online_days 需为 >=1 的数字')

    sud = dp.get('structure_upgrade_detect', True)
    if not isinstance(sud, bool):
        errors.append('data_processing.structure_upgrade_detect 需为布尔值')

    carriers = config.get('carriers', {})
    if not carriers:
        errors.append('carriers 不能为空')

    for carrier_key, carrier in carriers.items():
        if not carrier.get('enabled', False):
            continue
        api = carrier.get('api', {})
        aes_key = api.get('aes_key', '')
        aes_iv = api.get('aes_iv', '')
        if aes_key and len(aes_key) not in (16, 32):
            errors.append(f'carriers.{carrier_key}.api.aes_key 需为16或32字节字符串或留空')
        if aes_iv and len(aes_iv) != 16:
            errors.append(f'carriers.{carrier_key}.api.aes_iv 需为16字节字符串或留空')
        if carrier.get('default_province', '') not in PROVINCE_BY_CODE:
            errors.append(f'carriers.{carrier_key}.default_province 无效: {carrier.get("default_province")}')
        prov_codes = carrier.get('provinces', [])
        if prov_codes:
            invalid = [p for p in prov_codes if p not in PROVINCE_BY_CODE]
            if invalid:
                errors.append(f'carriers.{carrier_key}.provinces 包含无效省份代码: {invalid}')
        if carrier.get('category_mode') not in ('dynamic', 'fixed'):
            errors.append(f'carriers.{carrier_key}.category_mode 无效: {carrier.get("category_mode")}, 可选: dynamic/fixed')
        if carrier.get('category_mode') == 'fixed':
            if not isinstance(carrier.get('fixed_categories'), list) or len(carrier['fixed_categories']) == 0:
                errors.append(f'carriers.{carrier_key}.fixed_categories 在 category_mode=fixed 时不能为空')

        carrier_crawl = _deep_merge(crawl, carrier.get('crawl', {}))
        if carrier_crawl.get('pagination_mode') not in ('auto', 'bulk', 'page'):
            errors.append(f'carriers.{carrier_key}.crawl.pagination_mode 无效: {carrier_crawl.get("pagination_mode")}, 可选: auto/bulk/page')
        for key, lo, hi in [
            ('max_pages', 1, 20),
            ('retry_times', 1, 10),
            ('delay_min', 5, 600),
            ('delay_max', 5, 600),
            ('page_size', 100, 50000),
            ('category_interval_ms', 100, 30000),
            ('page_interval_ms', 50, 10000),
            ('retry_base_ms', 100, 60000),
            ('retry_max_ms', 1000, 600000),
        ]:
            v = carrier_crawl.get(key)
            if not isinstance(v, (int, float)) or v < lo or v > hi:
                errors.append(f'carriers.{carrier_key}.crawl.{key} 需在 {lo}-{hi} 之间, 当前: {v}')
        if carrier_crawl.get('delay_min', 0) >= carrier_crawl.get('delay_max', 1):
            errors.append(f'carriers.{carrier_key}.crawl.delay_min 必须小于 delay_max')
        if carrier_crawl.get('retry_base_ms', 0) >= carrier_crawl.get('retry_max_ms', 1):
            errors.append(f'carriers.{carrier_key}.crawl.retry_base_ms 必须小于 retry_max_ms')
        if not (0 <= carrier_crawl.get('retry_jitter', 0) <= 1):
            errors.append(f'carriers.{carrier_key}.crawl.retry_jitter 需在 0-1 之间')
        if not (0 <= carrier_crawl.get('jitter_ratio', 0) <= 1):
            errors.append(f'carriers.{carrier_key}.crawl.jitter_ratio 需在 0-1 之间')

        carrier_vol = _deep_merge(config['volatility'], carrier.get('volatility', {}))
        if not (0 <= carrier_vol.get('threshold', 0) <= 1):
            errors.append(f'carriers.{carrier_key}.volatility.threshold 需在 0-1 之间')
        if not (0 <= carrier_vol.get('threshold_sudden', 0) <= 1):
            errors.append(f'carriers.{carrier_key}.volatility.threshold_sudden 需在 0-1 之间')
        if carrier_vol.get('threshold', 0) >= carrier_vol.get('threshold_sudden', 1):
            errors.append(f'carriers.{carrier_key}.volatility.threshold 必须小于 threshold_sudden')
        if not (0 <= carrier_vol.get('surge_duplicate_threshold', 0.5) <= 1):
            errors.append(f'carriers.{carrier_key}.volatility.surge_duplicate_threshold 需在 0-1 之间')
        carrier_dart = carrier_vol.get('degrade_auto_recover_threshold', 0)
        if not isinstance(carrier_dart, int) or carrier_dart < 0 or carrier_dart > 20:
            errors.append(f'carriers.{carrier_key}.volatility.degrade_auto_recover_threshold 需为 0-20 之间的整数')

        carrier_notify = carrier.get('notification', {})
        notify_provs = carrier_notify.get('provinces')
        if notify_provs is not None:
            if not isinstance(notify_provs, list):
                errors.append(f'carriers.{carrier_key}.notification.provinces 需为数组')
            else:
                invalid = [p for p in notify_provs if p not in PROVINCE_BY_CODE]
                if invalid:
                    errors.append(f'carriers.{carrier_key}.notification.provinces 包含无效省份代码: {invalid}')

        cm = carrier.get('category_maps')
        if cm is not None:
            if not isinstance(cm, dict):
                errors.append(f'carriers.{carrier_key}.category_maps 需为对象')
            else:
                for sub_key in ('attr', 't1', 't2'):
                    sub = cm.get(sub_key)
                    if sub is not None and not isinstance(sub, dict):
                        errors.append(f'carriers.{carrier_key}.category_maps.{sub_key} 需为对象')

    if errors:
        raise ValueError('配置校验失败:\n' + '\n'.join(f'  - {e}' for e in errors))

    for carrier_key, carrier in config.get('carriers', {}).items():
        cm = carrier.get('category_maps') or {}
        if not isinstance(cm, dict):
            cm = {}
        norm = {}
        for sub_key in ('attr', 't1', 't2'):
            sub = cm.get(sub_key)
            if isinstance(sub, dict):
                norm[sub_key] = {str(k): str(v) for k, v in sub.items()}
            else:
                norm[sub_key] = {}
        CARRIER_CATEGORY_MAPS[carrier_key] = norm

    logger.info('配置校验通过')
    return config


def get_carrier_config(config, carrier_key):
    carrier = config['carriers'][carrier_key]
    crawl = _deep_merge(config['crawl'], carrier.get('crawl', {}))
    crawl['provinces'] = carrier.get('provinces', [])
    crawl['category_mode'] = carrier.get('category_mode', 'dynamic')
    crawl['fixed_categories'] = carrier.get('fixed_categories', []) or CARRIER_FIXED_CATEGORIES.get(carrier_key, DEFAULT_FIXED_CATEGORIES)
    volatility = _deep_merge(config['volatility'], carrier.get('volatility', {}))
    notification = _deep_merge(config['notification'], carrier.get('notification', {}))
    return {
        'api': carrier['api'],
        'default_province': carrier['default_province'],
        'provinces': carrier.get('provinces', []),
        'crawl': crawl,
        'volatility': volatility,
        'changelog': config['changelog'],
        'notification': notification,
        'storage': config['storage'],
        'schedule': config['schedule'],
        'category_maps': CARRIER_CATEGORY_MAPS.get(carrier_key, {'attr': {}, 't1': {}, 't2': {}}),
    }


_CARRIER_CODE_FIELD = {
    'cmcc': 'cmccCode', 'cucc': 'cuccCode', 'ctcc': 'ctccCode', 'cbn': 'cbnCode',
}

def get_target_provinces(config, carrier_key=None):
    codes = config['crawl'].get('provinces', [])
    if not codes:
        result = list(PROVINCES)
    else:
        result = [PROVINCE_BY_CODE[c] for c in codes if c in PROVINCE_BY_CODE]
    if carrier_key:
        field = _CARRIER_CODE_FIELD.get(carrier_key)
        if field:
            result = [p for p in result if p.get(field)]
    return result


# ════════════════════════════════════════════════════════════
#  API 交互: AES 加解密、HTTP 请求、分类动态获取、资费数据抓取
# ════════════════════════════════════════════════════════════

class BrowserLikeSSLAdapter(HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.create_default_context()
        ctx.check_hostname = True
        ctx.verify_mode = ssl.CERT_REQUIRED
        try:
            ctx.set_ciphers(
                'ECDHE-ECDSA-AES128-GCM-SHA256:'
                'ECDHE-RSA-AES128-GCM-SHA256:'
                'ECDHE-ECDSA-AES256-GCM-SHA384:'
                'ECDHE-RSA-AES256-GCM-SHA384:'
                'ECDHE-ECDSA-CHACHA20-POLY1305:'
                'ECDHE-RSA-CHACHA20-POLY1305:'
                'ECDHE-ECDSA-AES128-SHA256:'
                'ECDHE-RSA-AES128-SHA256:'
                'ECDHE-ECDSA-AES256-SHA384:'
                'ECDHE-RSA-AES256-SHA384'
            )
        except ssl.SSLError:
            pass
        ctx.options |= 0x4
        try:
            ctx.maximum_version = ssl.TLSVersion.TLSv1_3
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        except AttributeError:
            pass
        kwargs['ssl_context'] = ctx
        return super().init_poolmanager(*args, **kwargs)


def _create_session():
    session = requests.Session()
    retry = Retry(
        total=2,
        backoff_factor=0.5,
        status_forcelist=[],
        allowed_methods=['POST', 'GET'],
    )
    adapter = BrowserLikeSSLAdapter(max_retries=retry)
    session.mount('https://', adapter)
    session.mount('http://', adapter)
    return session


def now_iso():
    now = datetime.datetime.now(datetime.UTC)
    return now.strftime('%Y-%m-%dT%H:%M:%S.') + f'{now.microsecond // 1000:03d}Z'


def compute_next_crawl_time(interval_hours):
    now = datetime.datetime.now(datetime.UTC)
    next_time = now + datetime.timedelta(hours=interval_hours)
    return next_time.strftime('%Y-%m-%dT%H:%M:%S.') + f'{next_time.microsecond // 1000:03d}Z'


class _BaseCarrierApi:
    def __init__(self, config):
        self.config = config
        api_cfg = config['api']
        self.base_url = api_cfg['base_url']
        self.app_url = api_cfg['app_url']
        self.page_url = api_cfg['page_url']
        self.aes_key = api_cfg.get('aes_key', '').encode('utf-8')
        self.aes_iv = api_cfg.get('aes_iv', '').encode('utf-8')
        custom_pool = config.get('crawl', {}).get('ua_pool') or []
        self._ua_pool = custom_pool if custom_pool else UA_POOL
        self.session = _create_session()
        self._last_retry_count = 0

    # 设计决策：不区分连接/业务错误走不同重试策略（hunan 的差异化重试），原因：
    #   当前已实现指数退避+jitter+连接错误重建session，重试机制已足够。
    #   1. 能恢复的连接错误1-2次就恢复，3次够用。
    #   2. 需要更多重试的场景，统一调 retry_times 配置即可（如3→5），零代码改动。
    #   3. 恢复不了的错误，6次也恢复不了，只是多等60s才放弃。
    #   4. 业务错误少重试省几秒——但业务错误极少发生，收益可忽略。
    #   区分错误类型的代码复杂度不值得这点边际收益。
    def _call_with_retry(self, request_fn, *,
                         retry_times=None, retry_base_ms=None,
                         retry_max_ms=None, retry_jitter=None,
                         on_error=None):
        crawl = self.config.get('crawl', {})
        rt = retry_times if retry_times is not None else crawl.get('retry_times', 3)
        rb = retry_base_ms if retry_base_ms is not None else crawl.get('retry_base_ms', 1000)
        rm = retry_max_ms if retry_max_ms is not None else crawl.get('retry_max_ms', 30000)
        rj = retry_jitter if retry_jitter is not None else crawl.get('retry_jitter', 0.3)
        last_error = None
        for i in range(rt):
            try:
                result = request_fn()
                self._last_retry_count = i
                return result
            except Exception as e:
                last_error = e
                skip_backoff = False
                if on_error:
                    skip_backoff = on_error(e, i, rt)
                if not skip_backoff:
                    is_conn_err = isinstance(e, (requests.exceptions.SSLError,
                                                 requests.exceptions.ConnectionError))
                    if is_conn_err:
                        try:
                            self.session.close()
                        except Exception:
                            pass
                        self.session = _create_session()
                    if i < rt - 1:
                        base_wait = rb / 1000 * (2 ** i)
                        jitter_offset = base_wait * rj * (2 * random.random() - 1)
                        wait = max(0.1, base_wait + jitter_offset)
                        wait = min(wait, rm / 1000)
                        logger.debug(f'  请求失败, {wait:.1f}s 后重试({i + 2}/{rt}): {e}')
                        time.sleep(wait)
        self._last_retry_count = rt - 1
        raise last_error

    # ===== 业务码级重试（第2层）：修复联通江苏 2026-10-24 假下架事故 =====
    # 事故：cucc 江苏 operateData 批次返回非 '0000' 被静默 continue，379 条被当真实下架发布。
    # 分层设计：HTTP 层(_call_with_retry) → 业务码层(本方法，自身重试3次) → 分类级重试(通用循环)
    #   → partial 沿用旧快照。业务码异常在此自愈，自愈不了抛异常升级，永不静默丢弃。
    def _call_with_business_retry(self, request_fn, *, desc, expect_fn,
                                  retry_times=3, retry_base_ms=None,
                                  retry_max_ms=None, retry_jitter=None):
        """业务码校验重试：request_fn 返回后用 expect_fn 校验，不过则退避重试 retry_times 次；
        仍不过 → 抛 RuntimeError 交由上层分类级重试接管。
        request_fn 抛出的 HTTP 层异常直接传播（_post 内已做请求级重试，此处不重复兜底）。
        expect_fn(result) -> (bool, 失败原因描述)"""
        crawl = self.config.get('crawl', {})
        rb = retry_base_ms if retry_base_ms is not None else crawl.get('retry_base_ms', 1000)
        rm = retry_max_ms if retry_max_ms is not None else crawl.get('retry_max_ms', 30000)
        rj = retry_jitter if retry_jitter is not None else crawl.get('retry_jitter', 0.3)
        last_reason = None
        for i in range(retry_times):
            result = request_fn()
            ok, reason = expect_fn(result)
            if ok:
                return result
            last_reason = reason
            if i < retry_times - 1:
                base_wait = rb / 1000 * (2 ** i)
                jitter_offset = base_wait * rj * (2 * random.random() - 1)
                wait = min(max(0.1, base_wait + jitter_offset), rm / 1000)
                logger.warning(f'  {desc} 业务返回异常({reason}), {wait:.1f}s 后重试({i + 2}/{retry_times})')
                time.sleep(wait)
        raise RuntimeError(f'{desc} 业务返回异常, 自身重试{retry_times}次仍失败: {last_reason}')

    def resolve_categories(self, prov_code, category_mode, fixed_categories, **kwargs):
        if category_mode == 'fixed':
            return fixed_categories
        raise NotImplementedError(f'运营商 {self.__class__.__name__} 暂未实现动态分类获取')

    def get_tariff_list(self, *args, **kwargs):
        raise NotImplementedError(f'运营商 {self.__class__.__name__} 暂未实现资费列表获取')

    def close(self):
        try:
            self.session.close()
        except Exception:
            pass


class CmccApi(_BaseCarrierApi):
    APP_TOKEN_STR = 'JSESSIONID=;UID=;ticketID=;Comment=SessionServer-unity'

    def __init__(self, config):
        super().__init__(config)
        self.type2_url = self.base_url + 'nrapigate/nrtariff/new/Tariff/getType2List'
        self.tariff_url = self.base_url + 'nrapigate/nrtariff/new/Tariff/getTariffListInfo'

    def _get_cmcc_code(self, prov_code):
        prov = PROVINCE_BY_CODE.get(prov_code)
        if prov:
            return prov.get('cmccCode', '')
        logger.warning(f'  移动省份编码查找失败: prov_code={prov_code}, 使用固定分类')
        return ''

    def encrypt(self, plaintext):
        cipher = AES.new(self.aes_key, AES.MODE_CBC, self.aes_iv)
        padded = pad(plaintext.encode('utf-8'), AES.block_size)
        return cipher.encrypt(padded).hex().upper()

    def decrypt(self, hex_str):
        cipher = AES.new(self.aes_key, AES.MODE_CBC, self.aes_iv)
        raw = bytes.fromhex(hex_str)
        return unpad(cipher.decrypt(raw), AES.block_size).decode('utf-8')

    def _md5_hex(self, s):
        return hashlib.md5(s.encode('utf-8')).hexdigest()

    def _build_headers(self, xk, url_path):
        ts = int(time.time() * 1000)
        nc = ''.join(random.choice('0123456789') for _ in range(8))
        sign_str = f'{xk}_{url_path}_{ts}_{nc}'
        x_token = self.encrypt(sign_str)
        x_sign = self._md5_hex(f'{x_token}_{ts}_{nc}_null')
        trace_chars = string.ascii_letters + string.digits
        trace = f'{uuid.uuid4()}_{url_path}_{ts}_{"".join(random.choice(trace_chars) for _ in range(20))}'
        ua = _pick_ua(self._ua_pool)
        return {
            'User-Agent': ua,
            'Content-Type': 'application/json; charset=UTF-8',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'x-token': x_token,
            'x-time': str(ts),
            'x-nonce': nc,
            'x-sign': x_sign,
            'x-appToken': self.APP_TOKEN_STR,
            'x-app-version': '1.0.1',
            'x-group-env': '',
            'pagetype': '',
            'trace': trace,
        }

    def _build_encrypted_body(self, params, xk):
        params_with_xk = dict(params, xk=xk)
        return self.encrypt(json.dumps(params_with_xk, separators=(',', ':'), ensure_ascii=False))

    def _call(self, url, headers, encrypted_body, retry_times=3, retry_base_ms=1000, retry_max_ms=30000, retry_jitter=0.3):
        def do_request():
            resp = self.session.post(url, data=encrypted_body.encode('utf-8'), headers=headers, timeout=60)
            resp.raise_for_status()
            data = resp.json()
            body_hex = data.get('body') or ''
            if not body_hex:
                # 200但加密体为空：网关拥塞挂起/风控软拒的典型症状（挂起1-2分钟后返回空body）。
                # 抛异常交由 _call_with_retry 指数退避重试——静默返回None会绕过重试机制直接判死。
                raise RuntimeError('移动接口返回空body(疑似风控软拒), 已进入重试')
            plain = self.decrypt(body_hex)
            return json.loads(plain)
        return self._call_with_retry(do_request,
                                      retry_times=retry_times,
                                      retry_base_ms=retry_base_ms,
                                      retry_max_ms=retry_max_ms,
                                      retry_jitter=retry_jitter)

    def get_type2_list(self, prov_code, retry_times=3, retry_base_ms=1000, retry_max_ms=30000, retry_jitter=0.3):
        cmcc_prov = self._get_cmcc_code(prov_code)
        if not cmcc_prov:
            return None
        xk = str(uuid.uuid4())
        url_path = urlparse(self.type2_url).path
        headers = self._build_headers(xk, url_path)
        encrypted_body = self._build_encrypted_body({'province': cmcc_prov, 'isPublic': '1'}, xk)
        return self._call(self.type2_url, headers, encrypted_body,
                          retry_times=retry_times,
                          retry_base_ms=retry_base_ms,
                          retry_max_ms=retry_max_ms,
                          retry_jitter=retry_jitter)

    def get_tariff_list(self, prov_code, tariff_attr, type1, type2,
                        page=1, limit=10000,
                        retry_times=3, retry_base_ms=1000, retry_max_ms=30000, retry_jitter=0.3):
        cmcc_prov = self._get_cmcc_code(prov_code)
        if not cmcc_prov:
            return {'data': {'beans': []}}
        xk = str(uuid.uuid4())
        url_path = urlparse(self.tariff_url).path
        headers = self._build_headers(xk, url_path)
        params = {
            'cellNum': '99999999999',
            'province': cmcc_prov,
            'isPublic': '1',
            'linkScn': '1',
            'tariffAttr': tariff_attr,
            'type1': type1,
            'type2': type2,
            'page': page,
            'limit': limit,
        }
        encrypted_body = self._build_encrypted_body(params, xk)
        return self._call(self.tariff_url, headers, encrypted_body,
                          retry_times=retry_times,
                          retry_base_ms=retry_base_ms,
                          retry_max_ms=retry_max_ms,
                          retry_jitter=retry_jitter)

    def resolve_categories(self, prov_code, category_mode, fixed_categories,
                           retry_times=3, retry_base_ms=1000, retry_max_ms=30000, retry_jitter=0.3,
                           page_interval_ms=300):
        if category_mode == 'fixed':
            return fixed_categories

        logger.info(f'  请求 getType2List (province={self._get_cmcc_code(prov_code)})...')
        try:
            result = self.get_type2_list(prov_code,
                                         retry_times=retry_times, retry_base_ms=retry_base_ms,
                                         retry_max_ms=retry_max_ms, retry_jitter=retry_jitter)
            time.sleep(page_interval_ms / 1000)
        except Exception as e:
            logger.warning(f'  getType2List 失败: {e}, 使用固定分类')
            return fixed_categories

        items = (result or {}).get('data') or []
        categories = []
        seen = set()
        for it in items:
            ta = str(it.get('tariffAttr', ''))
            t1 = str(it.get('type1', ''))
            t2 = str(it.get('type2', ''))
            key = (ta, t1, t2)
            if not ta or not t1 or not t2 or key in seen:
                continue
            seen.add(key)
            categories.append({'tariffAttr': ta, 'type1': t1, 'type2': t2})

        logger.info(f'  getType2List 返回 {len(categories)} 个分类组合')
        return categories if categories else fixed_categories




class CuccApi(_BaseCarrierApi):
    DEFAULT_AES_KEY = b'6b8b4567327b23c6643c527d5b8c8a17'

    def __init__(self, config):
        super().__init__(config)
        cfg_key = (self.config.get('api', {}) or {}).get('aes_key', '')
        if isinstance(cfg_key, str) and cfg_key:
            self.aes_key = cfg_key.encode('utf-8')
        else:
            self.aes_key = self.DEFAULT_AES_KEY
        self.headers = {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': 'https://img.client.10010.com',
            'Referer': 'https://img.client.10010.com/zifeizhuanquwt/',
            'X-Requested-With': 'com.android.browser',
        }

    def _get_cucc_code(self, prov_code):
        prov = PROVINCE_BY_CODE.get(prov_code)
        if prov:
            return prov.get('cuccCode', ''), prov.get('cuccCityCode', '')
        logger.warning(f'  联通省份编码查找失败: prov_code={prov_code}, 使用固定分类')
        return '', ''

    def _decrypt_response(self, encrypted_str):
        try:
            ct = base64.b64decode(encrypted_str)
            cipher = AES.new(self.aes_key, AES.MODE_ECB)
            pt = unpad(cipher.decrypt(ct), AES.block_size)
            return json.loads(pt.decode('utf-8'))
        except Exception as e:
            logger.warning(f'联通响应解密失败: {e}')
            return None

    def _post(self, path, params):
        url = f'{self.base_url}{path}'
        headers = dict(self.headers)
        headers['User-Agent'] = _pick_ua(self._ua_pool)
        def do_request():
            resp = self.session.post(url, data=params, headers=headers, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, str):
                return self._decrypt_response(data)
            return data
        return self._call_with_retry(do_request)

    def resolve_categories(self, prov_code, category_mode, fixed_categories,
                           retry_times=3, retry_base_ms=1000, retry_max_ms=30000, retry_jitter=0.3,
                           page_interval_ms=300, **kwargs):
        if category_mode == 'fixed':
            return fixed_categories

        cucc_prov, cucc_city = self._get_cucc_code(prov_code)
        if not cucc_prov:
            return fixed_categories

        logger.info(f'  请求联通 indexData (province={cucc_prov})...')
        try:
            result = self._post('/queryTariffNew/indexData', {
                'provinceId': cucc_prov,
                'cityId': cucc_city,
            })
        except Exception as e:
            logger.warning(f'  联通 indexData 失败: {e}, 使用固定分类')
            return fixed_categories

        if not result or result.get('code') != '0000':
            logger.warning(f'  联通 indexData 返回异常, 使用固定分类')
            return fixed_categories

        categories = []
        level_list = result.get('data', {}).get('levelList', [])
        cucc_type2_map = {'1': '1', '2': '2', '3': '3'}
        for level in level_list:
            first_level = str(level.get('firstLevel', ''))
            first_level_name = str(level.get('firstLevelName', ''))
            t2 = cucc_type2_map.get(first_level, '4')
            for sl in level.get('secondLevels', []):
                for tariff_attr in ('1', '2'):
                    categories.append({
                        'tariffAttr': tariff_attr,
                        'type1': '1',
                        'type2': t2,
                        '_cucc_first': first_level,
                        '_cucc_first_name': first_level_name,
                        '_cucc_second': str(sl.get('secondLevel', '')),
                        '_cucc_second_name': str(sl.get('secondLevelName', '')),
                    })

        logger.info(f'  联通 indexData 返回 {len(categories)} 个分类组合')
        return categories if categories else fixed_categories

    def get_tariff_list(self, prov_code, tariff_attr, type1, type2,
                        page=1, limit=10000,
                        retry_times=3, retry_base_ms=1000, retry_max_ms=30000, retry_jitter=0.3,
                        _cucc_first=None, _cucc_second=None, **kwargs):
        cucc_prov, cucc_city = self._get_cucc_code(prov_code)
        if not cucc_prov:
            return {'data': {'beans': []}}

        # 业务码非 '0000' → 自身重试3次，仍败抛异常 → 通用循环分类级重试接管（原：静默返回空，产生假下架）
        three_result = self._call_with_business_retry(
            lambda: self._post('/queryTariffNew/threeLevelName', {
                'provinceId': cucc_prov,
                'cityId': cucc_city,
                'tariffAttributes': int(tariff_attr) if str(tariff_attr) in ('1', '2') else 1,
                'firstLevel': _cucc_first or '1',
                'secondLevel': _cucc_second or '1001',
            }),
            desc=f'联通 threeLevelName(prov={cucc_prov}, first={_cucc_first}, second={_cucc_second})',
            expect_fn=lambda r: (bool(r and r.get('code') == '0000'), 'code!=0000' if r else '空响应'),
            retry_base_ms=retry_base_ms, retry_max_ms=retry_max_ms, retry_jitter=retry_jitter,
        )

        items = three_result.get('data', {}).get('dataList', [])
        if not items:
            return {'data': {'beans': []}}

        menu_ids = [it.get('id') for it in items[:limit] if it.get('id')]
        if not menu_ids:
            return {'data': {'beans': []}}

        beans = []
        batch_size = 100
        for i in range(0, len(menu_ids), batch_size):
            batch = menu_ids[i:i + batch_size]
            joined_ids = '_'.join(batch)
            # 业务码非 '0000'/空 → 自身重试3次，仍败抛异常 → 分类级重试整类重跑（原：静默 continue 丢批次，2026-10-24 江苏假下架根因）
            detail = self._call_with_business_retry(
                lambda: self._post(f'/queryTariffNew/operateData/{joined_ids}', {
                    'provinceId': cucc_prov,
                    'cityId': cucc_city,
                    'page': page,
                    'size': limit,
                }),
                desc=f'联通 operateData 批次{i // batch_size + 1}',
                expect_fn=lambda d: (bool(d and d.get('code') == '0000'), 'code!=0000' if d else '空响应'),
                retry_base_ms=retry_base_ms, retry_max_ms=retry_max_ms, retry_jitter=retry_jitter,
            )

            data_obj = detail.get('data', {})
            detail_list = []
            for item in data_obj.get('dataList', []):
                details = item.get('detailsList', [])
                if details:
                    detail_list.extend(details)
                else:
                    detail_list.append(item)
            detail_list.extend(data_obj.get('detailList', []))
            for d in detail_list:
                name = _s(d.get('name') or d.get('tariffName'))
                if not name:
                    continue
                bean = {
                    'tariffName': name,
                    'nonModuleList': [{
                        'name': name,
                        'fees': _s(d.get('feesStandard')),
                        'feesUnit': _s(d.get('feeUnit') or '元/月'),
                        'reportNo': _s(d.get('reportNo') or d.get('id') or d.get('tariffId')),
                        'productCode': _s(d.get('productCode') or d.get('goodsCode')),
                        'applicablePeople': _s(d.get('applicablePeople') or d.get('crowd')),
                        'channel': _s(d.get('saleChnl') or d.get('saleChannel') or d.get('channel')),
                        'unsubscribe': _s(d.get('unsubscribeMethod') or d.get('unsubscribe')),
                        'responsibility': _s(d.get('responsibility') or d.get('breachOfContract') or d.get('contractDuty')),
                        'validPeriod': _s(d.get('validPeriod')),
                        'duration': _s(d.get('duration') or d.get('inNetRequire')),
                        'call': _s(d.get('minute') or d.get('callMinute')),
                        'data': _s(d.get('commonData') or d.get('data')),
                        'dataUnit': _s(d.get('dataUnit') or 'MB'),
                        'orientTraffic': _s(d.get('orientTraffic')),
                        'orientTrafficUnit': _s(d.get('orientTrafficUnit') or 'MB'),
                        'brandwidth': _s(d.get('broadBand') or d.get('broadband') or d.get('brandwidth')),
                        'sms': _s(d.get('sms') or d.get('smsCount')),
                        'tariffDesc': _s(d.get('serviceContent') or d.get('tariffDesc') or d.get('feeDesc') or d.get('productDesc') or d.get('extraFees')),
                        'status': _s(d.get('state') or d.get('status')),
                    }],
                }
                beans.append(bean)

        return {'data': {'beans': beans}}


def _ctcc_stealth_script():
    """电信浏览器反检测注入脚本（模块级，供资费与公告采集共用）。
    伪造 WebGL 厂商/plugins/chrome 对象/硬件参数等深层指纹——
    headless chromium 无 GPU 无插件，缺这套伪装会被瑞数判伪造（白屏+400）。"""
    def _make_eval_str(fun_js, *args):
        _args = ', '.join(json.dumps('undefined' if a is None else a) for a in args)
        return f'({fun_js})({_args})'
    _injections = [
        ('utils.js',),
        ('chrome.app.js',),
        ('chrome.runtime.js', False),
        ('iframe.contentWindow.js',),
        ('media.codecs.js',),
        ('navigator.languages.js', ['zh-CN', 'zh', 'en']),
        ('navigator.permissions.js',),
        ('navigator.plugins.js',),
        ('navigator.vendor.js', 'Google Inc.'),
        ('navigator.webdriver.js',),
        ('webgl.vendor.js', 'Intel Inc.', 'Intel Iris OpenGL Engine'),
        ('window.outerdimensions.js',),
    ]
    _parts = []
    for _item in _injections:
        _name = _item[0]
        _js = _STEALTH_JS_FILES.get(_name)
        if _js is None:
            logger.warning(f'  内嵌 stealth JS 缺失: {_name}')
            continue
        _parts.append(_make_eval_str(_js, *_item[1:]))
    _fix_js = r'''
(() => {
  try {
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
    if (window.chrome && !window.chrome.runtime) {
      Object.defineProperty(window.chrome, 'runtime', { value: { connect: () => {}, sendMessage: () => {} } });
    }
  } catch(e) {}
})();
'''
    _parts.append(_fix_js)
    return '\n'.join(_parts)


class CtccApi(_BaseCarrierApi):
    DIRECT_API_URL = 'https://www.189.cn/wapportalweb/wapportalweb/tariffSection.do'
    DIRECT_AES_KEY = b'telecom_wap_2018'

    def __init__(self, config):
        super().__init__(config)
        self._pw = None
        self._browser = None
        self._context = None
        self._page = None
        self._direct_api_url = config.get('api', {}).get('direct_api_url', '') or self.DIRECT_API_URL
        self._direct_aes_key = config.get('api', {}).get('direct_aes_key', '').encode('utf-8') if config.get('api', {}).get('direct_aes_key') else self.DIRECT_AES_KEY

    def _stealth_init_script(self):
        return _ctcc_stealth_script()

    def _ensure_browser(self, force=False):
        if self._page is not None and not force:
            return
        self._close_browser()
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise RuntimeError('电信采集需要 playwright 依赖，请安装: pip install playwright && playwright install chromium')
        self._pw = sync_playwright().start()
        _launch_args = [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-dev-shm-usage',
        ]
        _system_bins = []
        for _bin in (shutil.which('chromium'), shutil.which('chromium-browser'), shutil.which('google-chrome'),
                     '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'):
            if _bin and os.path.exists(_bin) and _bin not in _system_bins:
                _system_bins.append(_bin)
        _launch_opts = []
        for _bin in _system_bins:
            _launch_opts.append({'executable_path': _bin, 'headless': True, 'args': _launch_args})
        _launch_opts.append({'channel': 'msedge', 'headless': True, 'args': _launch_args})
        _launch_opts.append({'channel': 'chromium', 'headless': True, 'args': _launch_args})
        _launch_opts.append({'headless': True, 'args': _launch_args})
        _last_err = None
        _used = ''
        for _opts in _launch_opts:
            try:
                self._browser = self._pw.chromium.launch(**_opts)
                _used = _opts.get('executable_path') or _opts.get('channel') or 'playwright-chromium'
                break
            except Exception as _e:
                _last_err = _e
                self._browser = None
                continue
        if self._browser is None:
            raise RuntimeError(f'无法启动浏览器，所有方式均失败: {_last_err}')
        logger.info(f'  浏览器启动成功 ({_used})')
        self._context = self._browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.4234.32',
            locale='zh-CN',
            viewport={'width': 1280, 'height': 800},
        )
        _init_script = self._stealth_init_script()
        if _init_script:
            self._context.add_init_script(_init_script)
        self._page = self._context.new_page()
        self._page.goto('https://www.189.cn/tariffZone/', timeout=60000, wait_until='domcontentloaded')
        for _i in range(6):
            time.sleep(5)
            _cookies = [c['name'] for c in self._context.cookies()]
            if any(n.startswith('EYg4') for n in _cookies):
                break
        logger.info('  电信浏览器已启动，瑞数环境就绪')

    def _close_browser(self):
        for _attr in ('_page', '_context', '_browser'):
            _obj = getattr(self, _attr, None)
            if _obj is not None:
                try:
                    _obj.close()
                except Exception:
                    pass
            setattr(self, _attr, None)
        if self._pw is not None:
            try:
                self._pw.stop()
            except Exception:
                pass
            self._pw = None

    def close(self):
        self._close_browser()
        super().close()
        logger.info('电信浏览器已关闭')

    def _direct_encrypt(self, plaintext):
        cipher = AES.new(self._direct_aes_key, AES.MODE_ECB)
        padded = pad(plaintext.encode('utf-8'), 16)
        return base64.b64encode(cipher.encrypt(padded)).decode('utf-8')

    def _direct_call(self, function_code, request_content,
                     retry_times=None, retry_base_ms=None,
                     retry_max_ms=None, retry_jitter=None):
        payload = json.dumps({
            'headerInfo': {'functionCode': function_code},
            'requestContent': request_content,
        }, ensure_ascii=False)
        body = self._direct_encrypt(payload)
        headers = {
            'User-Agent': _pick_ua(self._ua_pool),
            'Referer': 'https://www.189.cn/wapportalweb/rateZone/index.html',
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'text/plain;charset=UTF-8',
            'Origin': 'https://www.189.cn',
            'x-qd-reqtime': str(int(time.time() * 1000)),
        }
        def do_request():
            resp = self.session.post(
                self._direct_api_url,
                data=body.encode('utf-8'),
                headers=headers,
                timeout=60,
            )
            resp.raise_for_status()
            return resp.json()
        return self._call_with_retry(do_request,
                                      retry_times=retry_times,
                                      retry_base_ms=retry_base_ms,
                                      retry_max_ms=retry_max_ms,
                                      retry_jitter=retry_jitter)

    def _direct_home(self, prov_code):
        ctcc_prov = self._get_ctcc_code(prov_code)
        if not ctcc_prov:
            raise Exception(f'电信直连: 未找到省份编码 prov_code={prov_code}')
        data = self._direct_call('tariffSectionHome', {
            'ticket': '', 'sessionid': '', 'provCode': ctcc_prov,
        })
        rc = data.get('responseContent', {})
        return rc

    def _direct_query(self, session_id, prov_code, lable1_id):
        ctcc_prov = self._get_ctcc_code(prov_code)
        data = self._direct_call('tariffSectionQuery', {
            'sessionid': session_id, 'type': 1,
            'provCode': ctcc_prov, 'lable1Id': lable1_id, 'lable2Id': '',
        })
        rc = data.get('responseContent', {})
        return rc

    @staticmethod
    def _direct_fmt_date(s):
        if not s:
            return ''
        t = str(s).strip()
        if len(t) >= 10 and t[4] == '-':
            return t[:10]
        if len(t) >= 8 and t[:8].isdigit():
            return f'{t[:4]}-{t[4:6]}-{t[6:8]}'
        return t[:10]

    def _parse_wap_item(self, x, prov_code, prov_name, l1_name='', l2_name=''):
        fee = _s(x.get('fees'))
        title = _s(x.get('name'))
        report_no = _s(x.get('reportNo')) or _s(x.get('id'))
        if not report_no:
            report_no = hashlib.md5((title + fee).encode('utf-8')).hexdigest()
        nm = {
            'name': title,
            'fees': fee,
            'feesUnit': _s(x.get('feesUnit')),
            'reportNo': report_no,
            'applicablePeople': _s(x.get('applicablePeople')),
            'channel': _s(x.get('channel')),
            'validPeriod': _s(x.get('validPeriod')),
            'unsubscribe': _s(x.get('unsubscribe')),
            'duration': _s(x.get('duration')),
            'responsibility': _s(x.get('responsibility')),
            'onlineDay': self._direct_fmt_date(x.get('onlineDay')),
            'offlineDay': self._direct_fmt_date(x.get('offlineDay')),
            'call': _s(x.get('call')),
            'data': _s(x.get('data')),
            'dataUnit': _s(x.get('dataUnit')),
            'orientTraffic': _s(x.get('orientTraffic')),
            'orientTrafficUnit': _s(x.get('orientTrafficUnit')),
            'sms': _s(x.get('sms')),
            'iptv': _s(x.get('iptv')),
            'bandwidth': _s(x.get('bandwidth')),
            'otherFees': _s(x.get('otherFees')),
            'rights': _s(x.get('rights')),
            'otherContent': _s(x.get('otherContent')),
            'lable1Name': l1_name,
            'type1': _s(x.get('type1')),
            'type2': _s(x.get('type2')),
        }
        bean = {
            'tariffName': title,
            'nonModuleList': [nm],
        }
        return bean

    def crawl_direct(self, prov_code, prov_name, carrier_key='ctcc'):
        ctcc_prov = self._get_ctcc_code(prov_code)
        logger.info(f'  [直连] 电信 tariffSectionHome (provCode={ctcc_prov})...')
        rc = self._direct_home(prov_code)
        session_id = rc.get('sessionid')
        boards = rc.get('lableOneList') or []
        logger.info(f'  [直连] session={session_id}, 板块={[b.get("name") for b in boards]}')
        if not boards:
            raise Exception(f'电信直连: Home 未返回板块 (provCode={ctcc_prov})')

        all_items = []
        seen_ids = set()
        failed_categories = []
        failed_cat_keys = []   # 失败板块的结构化键：供 partial 省沿用旧快照条目
        province_diag = {'name': prov_name, 'code': prov_code, 'categories': []}

        name_to_type2 = {'套餐': '1', '加装包': '2', '营销活动': '3'}

        for bi, board in enumerate(boards):
            l1_id = board.get('id', '')
            l1_name = board.get('name', '')
            t2_code = name_to_type2.get(l1_name, '4')
            logger.info(f'  [直连] [{bi + 1}/{len(boards)}] 查询板块: {l1_name} (id={l1_id})')
            board_start = time.time()
            board_failed = False
            board_fail_reason = None
            board_retries = 0
            try:
                rq = self._direct_query(session_id, prov_code, l1_id)
                board_retries = getattr(self, '_last_retry_count', 0)
            except Exception as e:
                board_retries = getattr(self, '_last_retry_count', 0)
                board_failed = True
                board_fail_reason = str(e)[:100]
                logger.warning(f'  [直连] 板块 {l1_name} 查询失败: {e}')
                failed_categories.append(l1_name)
                failed_cat_keys.append({'attr': '1', 't1': '1', 't2': t2_code})
                province_diag['categories'].append({
                    'attr': '1', 't1': '1', 't2': t2_code,
                    'pages': 0, 'items': 0,
                    'retries': board_retries,
                    'ms': int((time.time() - board_start) * 1000),
                    'status': 'fail', 'reason': board_fail_reason,
                })
                continue
            lst = rq.get('zoneTitleList') or []
            count_reported = rq.get('zoneTitleListCount', '?')
            cat_items = []
            for x in lst:
                bean = self._parse_wap_item(x, prov_code, prov_name, l1_name=l1_name)
                items = standardize_bean(bean, prov_code, prov_name, '1', '1',
                                         t2_code,
                                         carrier=carrier_key)
                for item in items:
                    if item['id'] not in seen_ids:
                        seen_ids.add(item['id'])
                        all_items.append(item)
                        cat_items.append(item)
            logger.info(f'  [直连] 板块 {l1_name}: 报告{count_reported}条, 实际{len(cat_items)}条')
            province_diag['categories'].append({
                'attr': '1', 't1': '1', 't2': t2_code,
                'pages': 1, 'items': len(cat_items),
                'retries': board_retries,
                'ms': int((time.time() - board_start) * 1000),
                'status': 'ok', 'reason': None,
            })
            time.sleep(0.45)

        status = 'success' if not failed_categories else ('partial' if all_items else 'failed')
        if failed_categories:
            logger.warning(f'  [直连] {len(failed_categories)} 个板块查询失败: {", ".join(failed_categories)}')

        return {
            'province': prov_name,
            'code': prov_code,
            'items': all_items,
            'total': len(all_items),
            'status': status,
            'failed_categories': failed_categories,
            'failed_cat_keys': failed_cat_keys,
            'content_duplicate_ratio': compute_content_duplicate_ratio(all_items),
            'diag': province_diag,
        }

    def _fetch(self, path, params=None):
        from urllib.parse import urlencode
        self._ensure_browser()
        url = f'{self.base_url}{path}'
        if params:
            url = f'{url}?{urlencode(params)}'
        result = self._page.evaluate('''
            (url) => {
                return new Promise((resolve) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('GET', url, true);
                    xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
                    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
                    xhr.onload = function() {
                        resolve({status: xhr.status, body: xhr.responseText, url: xhr.responseURL});
                    };
                    xhr.onerror = function() {
                        resolve({status: 0, body: '', error: 'XHR error', url: url});
                    };
                    xhr.send();
                });
            }
        ''', url)
        status = result.get('status', 0)
        text = result.get('body', '')
        if status == 412 or 'Precondition Failed' in text or '瑞数' in text:
            raise Exception('瑞数WAF拦截(412)')
        stripped = text.lstrip()
        if not (stripped.startswith('{') or stripped.startswith('[')):
            raise Exception('瑞数WAF拦截(非JSON响应)')
        _data = json.loads(text)
        if isinstance(_data, dict) and str(_data.get('code')) != '0':
            logger.debug(f'  电信 API 非零响应 code={_data.get("code")}: {text[:300]}')
        return _data

    def _fetch_with_retry(self, path, params=None,
                          retry_times=None, retry_base_ms=None,
                          retry_max_ms=None, retry_jitter=None):
        def on_error(e, i, rt):
            msg = str(e)
            if ('412' in msg or 'WAF' in msg or '未获取' in msg or '非JSON' in msg):
                logger.warning(f'  电信瑞数拦截，重载页面 (重试{i+1}/{rt})')
                self._ensure_browser(force=True)
                time.sleep(2)
                return True
            return False

        def do_request():
            return self._fetch(path, params)

        return self._call_with_retry(do_request,
                                      retry_times=retry_times,
                                      retry_base_ms=retry_base_ms,
                                      retry_max_ms=retry_max_ms,
                                      retry_jitter=retry_jitter,
                                      on_error=on_error)

    def _get_ctcc_code(self, prov_code):
        prov = PROVINCE_BY_CODE.get(prov_code)
        if prov:
            return prov.get('ctccCode', '')
        logger.warning(f'  电信省份编码查找失败: prov_code={prov_code}, 使用固定分类')
        return ''

    def _set_city_code_cookie(self, prov_code):
        prov = PROVINCE_BY_CODE.get(prov_code)
        if not prov:
            return
        city_code = prov.get('cityCode', '')
        if not city_code:
            return
        try:
            self._context.add_cookies([{
                'name': 'cityCode',
                'value': city_code,
                'domain': '.189.cn',
                'path': '/',
            }])
        except Exception as e:
            logger.debug(f'  设置 cityCode cookie 失败: {e}')

    def _parse_jbxx(self, html):
        result = {}
        if not html:
            return result
        patterns = {
            '资费类型': r'资费类型：</span>(.*?)</p>',
            '资费标准': r'资费标准：</span>(.*?)</p>',
            '适用范围': r'适用范围：</span>(.*?)</p>',
            '销售渠道': r'销售渠道：</span>(.*?)</p>',
            '上下线时间': r'上下线时间：</span>(.*?)</p>',
            '有效期限': r'有效期限：</span>(.*?)</p>',
            '退订方式': r'退订方式：</span>(.*?)</p>',
            '在网要求': r'在网要求：</span>(.*?)</p>',
            '违约责任': r'违约责任：</span>(.*?)</p>',
        }
        for key, pat in patterns.items():
            m = re.search(pat, html, re.DOTALL)
            if m:
                result[key] = re.sub(r'<[^>]+>', '', m.group(1)).strip()
        time_range = result.get('上下线时间', '')
        if '至' in time_range:
            parts = time_range.split('至')
            result['_online'] = parts[0].strip()
            result['_offline'] = parts[1].strip()
        return result

    def _parse_ffnr(self, html):
        result = {'call': '', 'data': '', 'orientTraffic': ''}
        if not html:
            return result
        headers = re.findall(r'<th>(.*?)</th>', html)
        cells = re.findall(r'<td>(.*?)</td>', html)
        for i, h in enumerate(headers):
            if i < len(cells):
                val = re.sub(r'<[^>]+>', '', cells[i]).strip()
                if '语音' in h:
                    result['call'] = val.replace('分钟', '').replace('.00', '')
                elif '通用流量' in h:
                    result['data'] = val.replace('MB', '').replace('GB', '')
                    result['dataUnit'] = 'GB' if 'GB' in val else 'MB'
                elif '定向流量' in h:
                    result['orientTraffic'] = val.replace('MB', '').replace('GB', '')
                    result['orientTrafficUnit'] = 'GB' if 'GB' in val else 'MB'
        return result

    def resolve_categories(self, prov_code, category_mode, fixed_categories,
                           retry_times=3, retry_base_ms=1000, retry_max_ms=30000, retry_jitter=0.3,
                           page_interval_ms=300, **kwargs):
        if category_mode == 'fixed':
            return fixed_categories

        ctcc_prov = self._get_ctcc_code(prov_code)
        if not ctcc_prov:
            return fixed_categories

        self._set_city_code_cookie(prov_code)
        logger.info(f'  请求电信 newTarifZone12List (provCode={ctcc_prov})...')
        try:
            result = self._fetch_with_retry('newTarifZone12List.do', {'provCode': ctcc_prov},
                                            retry_times=retry_times, retry_base_ms=retry_base_ms,
                                            retry_max_ms=retry_max_ms, retry_jitter=retry_jitter)
            time.sleep(page_interval_ms / 1000)
        except Exception as e:
            logger.warning(f'  电信 newTarifZone12List 失败: {e}, 使用固定分类')
            return fixed_categories

        if not result or str(result.get('code')) != '0':
            logger.warning(f'  电信 newTarifZone12List 返回异常, 使用固定分类')
            return fixed_categories

        categories = []
        name_to_type2 = {'套餐': '1', '加装包': '2', '营销活动': '3'}
        for cat in result.get('dataObject', []):
            name = cat.get('lable1Name', '')
            categories.append({
                'tariffAttr': '1',
                'type1': '1',
                'type2': name_to_type2.get(name, '4'),
                '_ctcc_lable1Id': cat.get('lable1Id', ''),
            })

        if not categories:
            logger.warning(f'  电信 newTarifZone12List dataObject 为空: {json.dumps(result, ensure_ascii=False)[:500]}')

        logger.info(f'  电信 newTarifZone12List 返回 {len(categories)} 个分类')
        return categories if categories else fixed_categories

    def get_tariff_list(self, prov_code, tariff_attr, type1, type2,
                        page=1, limit=10000,
                        retry_times=3, retry_base_ms=1000, retry_max_ms=30000, retry_jitter=0.3,
                        _ctcc_lable1Id=None, **kwargs):
        ctcc_prov = self._get_ctcc_code(prov_code)
        if not ctcc_prov or not _ctcc_lable1Id:
            return {'data': {'beans': []}}

        self._set_city_code_cookie(prov_code)
        # 业务码非 '0'/异常 → 自身重试3次，仍败抛异常 → 分类级重试接管（原：静默返回空）
        result = self._call_with_business_retry(
            lambda: self._fetch_with_retry('newTarifZone3Title.do', {
                'provCode': ctcc_prov,
                'lable1Id': _ctcc_lable1Id,
                'page': page,
                'limit': limit,
            }, retry_times=retry_times, retry_base_ms=retry_base_ms,
               retry_max_ms=retry_max_ms, retry_jitter=retry_jitter),
            desc=f'电信 newTarifZone3Title(lable1Id={_ctcc_lable1Id}, page={page})',
            expect_fn=lambda r: (bool(r and str(r.get('code')) == '0'), 'code!=0' if r else '空响应'),
            retry_base_ms=retry_base_ms, retry_max_ms=retry_max_ms, retry_jitter=retry_jitter,
        )

        beans = []
        for item in result.get('dataObject', []):
            name = _s(item.get('name'))
            if not name:
                continue
            jbxx = self._parse_jbxx(item.get('jbxx', ''))
            ffnr = self._parse_ffnr(item.get('ffnr', ''))
            bean = {
                'tariffName': name,
                'nonModuleList': [{
                    'name': name,
                    'fees': jbxx.get('资费标准', '').replace('元/月', '').replace('(全周期)', ''),
                    'feesUnit': '元/月',
                    'reportNo': _s(item.get('report_no') or item.get('reportNo')),
                    'applicablePeople': jbxx.get('适用范围', ''),
                    'channel': jbxx.get('销售渠道', ''),
                    'validPeriod': jbxx.get('有效期限', ''),
                    'unsubscribe': jbxx.get('退订方式', ''),
                    'duration': jbxx.get('在网要求', ''),
                    'responsibility': jbxx.get('违约责任', ''),
                    'onlineDay': jbxx.get('_online', ''),
                    'offlineDay': jbxx.get('_offline', ''),
                    'call': ffnr.get('call', ''),
                    'data': ffnr.get('data', ''),
                    'dataUnit': ffnr.get('dataUnit', 'MB'),
                    'orientTraffic': ffnr.get('orientTraffic', ''),
                    'orientTrafficUnit': ffnr.get('orientTrafficUnit', 'MB'),
                    'otherContent': _s(item.get('other_content') or item.get('otherContent')),
                    'lable1Name': _s(item.get('lable1Name')),
                    'lable1Id': _s(item.get('lable1Id')),
                    'jbxx_html': _s(item.get('jbxx')),
                    'ffnr_html': _s(item.get('ffnr')),
                }],
            }
            beans.append(bean)

        return {'data': {'beans': beans}}


class CbnApi(_BaseCarrierApi):
    CHANNEL_ID = 'cd_20220914_514144'

    def __init__(self, config):
        super().__init__(config)
        self.headers = {
            'Content-Type': 'application/json;charset=utf-8',
            'Referer': 'https://m.10099.com.cn/expensesNotice/',
        }

    def _get_cbn_code(self, prov_code):
        prov = PROVINCE_BY_CODE.get(prov_code)
        if prov:
            return prov.get('cbnCode', '')
        logger.warning(f'  广电省份编码查找失败: prov_code={prov_code}, 使用固定分类')
        return ''

    def _sign(self, params):
        sorted_params = sorted(params.items(), key=lambda x: x[0])
        query_string = '&'.join(f'{k}={v}' for k, v in sorted_params)
        return hashlib.md5(query_string.encode('utf-8')).hexdigest()

    def _post(self, path, params):
        params = dict(params)
        params['timestamp'] = int(time.time() * 1000)
        access = self._sign(params)
        headers = dict(self.headers)
        headers['Access'] = access
        headers['User-Agent'] = _pick_ua(self._ua_pool)
        url = f'{self.base_url}{path}'
        def do_request():
            resp = self.session.post(url, json=params, headers=headers, timeout=30)
            resp.raise_for_status()
            return resp.json()
        return self._call_with_retry(do_request)

    def resolve_categories(self, prov_code, category_mode, fixed_categories,
                           retry_times=3, retry_base_ms=1000, retry_max_ms=30000, retry_jitter=0.3,
                           page_interval_ms=300, **kwargs):
        if category_mode == 'fixed':
            return fixed_categories

        cbn_prov = self._get_cbn_code(prov_code)
        if not cbn_prov:
            return fixed_categories

        logger.info(f'  请求广电 queryTariffCondition (area={cbn_prov})...')
        try:
            result = self._post('/goods/queryTariffCondition', {
                'channelId': self.CHANNEL_ID,
                'applicableArea': cbn_prov,
            })
        except Exception as e:
            logger.warning(f'  广电 queryTariffCondition 失败: {e}, 使用固定分类')
            return fixed_categories

        if not result or not result.get('ok'):
            logger.warning(f'  广电 queryTariffCondition 返回异常, 使用固定分类')
            return fixed_categories

        categories = []
        type1_map = {'GZ': '1', 'ZQ': '2'}
        for t1 in result.get('data', []):
            t1_code = t1.get('typeCode', '')
            if not t1.get('childTariffTypes'):
                continue
            mapped_t1 = type1_map.get(t1_code, '1')
            categories.append({
                'tariffAttr': '1',
                'type1': mapped_t1,
                'type2': '1',
                '_cbn_type1': t1_code,
                '_cbn_type2': '',
                '_cbn_type3': '',
            })

        if not categories:
            categories = [{'tariffAttr': '1', 'type1': '1', 'type2': '1',
                           '_cbn_type1': 'GZ', '_cbn_type2': '', '_cbn_type3': ''}]

        logger.info(f'  广电使用合并分类模式: {len(categories)} 个分类 (仅 type1), type2/type3 从数据中提取')
        return categories

    def get_tariff_list(self, prov_code, tariff_attr, type1, type2,
                        page=1, limit=10000,
                        retry_times=3, retry_base_ms=1000, retry_max_ms=30000, retry_jitter=0.3,
                        _cbn_type1='GZ', _cbn_type2='', _cbn_type3='', **kwargs):
        cbn_prov = self._get_cbn_code(prov_code)
        if not cbn_prov:
            return {'data': {'beans': []}}

        # 业务码 ok 非 true/异常 → 自身重试3次，仍败抛异常 → 分类级重试接管（原：静默返回空）
        result = self._call_with_business_retry(
            lambda: self._post('/goods/queryTariffAllByCond', {
                'channelId': self.CHANNEL_ID,
                'type1': _cbn_type1,
                'type2': _cbn_type2,
                'type3': _cbn_type3,
                'productName': '',
                'stateFlag': '1',
                'minPrice': '',
                'maxPrice': '',
                'applicableArea': cbn_prov,
                'pageNum': page,
                'pageSize': limit,
            }),
            desc=f'广电 queryTariffAllByCond(area={cbn_prov}, page={page})',
            expect_fn=lambda r: (bool(r and r.get('ok')), 'ok!=true' if r else '空响应'),
            retry_base_ms=retry_base_ms, retry_max_ms=retry_max_ms, retry_jitter=retry_jitter,
        )

        cbn_type2_map = {'TC': '1', 'JZB': '2', 'YXHD': '3'}
        cbn_type1_map = {'GZ': '1', 'ZQ': '2'}
        beans = []
        for item in result.get('data', []):
            name = _s(item.get('productName'))
            if not name:
                continue
            price = item.get('productPrice', 0)
            price_yuan = str(price / 100) if isinstance(price, (int, float)) and price >= 0 else ''
            raw_type2 = _s(item.get('type2'))
            mapped_type2 = '1'
            for suffix, std in cbn_type2_map.items():
                if raw_type2.endswith(suffix):
                    mapped_type2 = std
                    break
            raw_type1 = _s(item.get('type1'))
            mapped_type1 = cbn_type1_map.get(raw_type1, '1')
            bean = {
                'tariffName': name,
                'nonModuleList': [{
                    'name': name,
                    'type1': mapped_type1,
                    'type2': mapped_type2,
                    'fees': price_yuan,
                    'feesUnit': _s(item.get('productPriceUnit') or '元/月'),
                    'reportNo': _s(item.get('filingNumber')),
                    'productCode': _s(item.get('productCode')),
                    'productName': name,
                    'applicablePeople': _s(item.get('applicablePeople')),
                    'applicableArea': _s(item.get('applicableArea')),
                    'channel': _s(item.get('saleChannel')),
                    'unsubscribe': _s(item.get('unsubscribeMethod')),
                    'responsibility': _s(item.get('responsibility')),
                    'mutexRule': _s(item.get('mutexRule')),
                    'expireRule': _s(item.get('expirationRule')),
                    'accessReq': _s(item.get('onlineRequirements')),
                    'duration': _s(item.get('duration')),
                    'validPeriod': _s(item.get('validPeriod')),
                    'onlineDay': _s(item.get('onlineDay')),
                    'offlineDay': _s(item.get('offlineDay')),
                    'call': _s(item.get('domesticCall')),
                    'data': _s(item.get('domesticTraffic')),
                    'dataUnit': _s(item.get('domesticTrafficUnit') or 'GB'),
                    'orientTraffic': _s(item.get('orientTraffic')),
                    'orientTrafficUnit': _s(item.get('orientTrafficUnit') or 'GB'),
                    'areaTraffic': _s(item.get('regionTraffic')),
                    'areaTrafficUnit': _s(item.get('regionTrafficUnit') or 'GB'),
                    'brandwidth': _s(item.get('bandwidth')),
                    'iptv': _s(item.get('iptv')),
                    'sms': _s(item.get('sms')),
                    'familyNet': _s(item.get('familyNetwork')),
                    'rights': _s(item.get('rights')),
                    'otherContent': _s(item.get('otherContent')),
                    'otherDesc': _s(item.get('otherExplain')),
                    'status': _s(item.get('stateFlag')),
                    'updateTime': _s(item.get('updateDate')),
                    'createTime': _s(item.get('createDate')),
                    'parentTypeCode': _s(item.get('parentTypeCode')),
                    'parentTypeGrade': _s(item.get('parentTypeGrade')),
                    'reserveStr1': _s(item.get('reserveStr1')),
                    'reserveStr2': _s(item.get('reserveStr2')),
                    'reserveStr3': _s(item.get('reserveStr3')),
                }],
            }
            beans.append(bean)

        return {'data': {'beans': beans}}


def create_carrier_api(carrier_key, carrier_cfg):
    factories = {
        'cmcc': CmccApi,
        'cucc': CuccApi,
        'ctcc': CtccApi,
        'cbn': CbnApi,
    }
    cls = factories.get(carrier_key)
    if cls is None:
        raise ValueError(f'未知运营商: {carrier_key}, 可选: {list(factories.keys())}')
    logger.info(f'创建运营商 API 实例: {cls.__name__}')
    return cls(carrier_cfg)


# ════════════════════════════════════════════════════════════
#  数据解析: 原始 API 数据 → v2 schema 格式转换
# ════════════════════════════════════════════════════════════

def _s(v):
    return '' if v is None else str(v).strip()


def _fmt_day(s):
    s = _s(s)
    if len(s) == 8 and s.isdigit():
        return f'{int(s[:4])}年{int(s[4:6])}月{int(s[6:8])}日'
    return s


def _area_cn(s, city_map=None):
    parts = [_s(x) for x in _s(s).split(',') if _s(x)]
    out = []
    for p in parts:
        if city_map and p in city_map:
            out.append(city_map[p])
        else:
            out.append(p)
    return '、'.join(out)


def _strip_trailing(val, suffixes):
    for s in suffixes:
        if s and val.endswith(s):
            return val[:-len(s)]
    return val


def _nm_to_fields(nm, tariff_attr='1', t1='1', t2='1', carrier='cmcc'):
    f = {}
    _fees_raw = _s(nm.get('fees'))
    _unit_raw = _s(nm.get('feesUnit') or nm.get('priceUnit'))
    if _unit_raw and '元' not in _unit_raw:
        _unit_raw = '元/' + _unit_raw
    f['资费标准'] = (_fees_raw + _unit_raw).strip()
    f['方案编号'] = _s(nm.get('reportNo')) or _s(nm.get('goodsid'))
    f['产品名称'] = _s(nm.get('name') or nm.get('tariffName') or nm.get('productName'))
    f['资费类型'] = _get_t2_label(carrier, t2)
    f['归属'] = _get_t1_label(carrier, str(nm.get('type1', t1)))
    f['产品编码'] = _s(nm.get('productCode') or nm.get('goodsCode') or nm.get('goodsid'))
    f['产品价格'] = _s(nm.get('price'))
    f['价格单位'] = _unit_raw
    f['上线日期'] = _fmt_day(nm.get('onlineDay'))
    f['下线日期'] = _fmt_day(nm.get('offineDay') or nm.get('offlineDay'))
    f['有效期限'] = _s(nm.get('validPeriod'))
    f['在网要求'] = _s(nm.get('duration'))
    f['适用范围'] = _s(nm.get('applicablePeople'))
    f['适用地区'] = _area_cn(nm.get('applicableArea'))
    f['销售渠道'] = _s(nm.get('channel'))
    f['退订方式'] = _s(nm.get('unsubscribe'))
    f['违约责任'] = _s(nm.get('responsibility'))
    f['互斥规则'] = _s(nm.get('mutexRule') or nm.get('exclusiveRule'))
    f['到期规则'] = _s(nm.get('expireRule') or nm.get('dueRule'))
    f['入网要求'] = _s(nm.get('accessReq') or nm.get('netInReq'))
    _call_raw = _s(nm.get('call'))
    f['国内通话'] = f'{_strip_trailing(_call_raw, ["分钟"])}分钟' if _call_raw else ''
    _data_raw = _s(nm.get('data'))
    _data_unit = _s(nm.get('dataUnit'))
    f['国内通用流量'] = _strip_trailing(_data_raw, [_data_unit, "GB", "MB", "TB"]) + _data_unit if _data_raw else ''
    _orient_raw = _s(nm.get('orientTraffic'))
    _orient_unit = _s(nm.get('orientTrafficUnit'))
    f['定向流量'] = _strip_trailing(_orient_raw, [_orient_unit, "GB", "MB", "TB"]) + _orient_unit if _orient_raw else ''
    _area_raw = _s(nm.get('areaTraffic'))
    _area_unit = _s(nm.get('areaTrafficUnit'))
    f['区域流量'] = _strip_trailing(_area_raw, [_area_unit, "GB", "MB", "TB"]) + _area_unit if _area_raw else ''
    f['宽带'] = _s(nm.get('brandwidth'))
    f['移动高清'] = _s(nm.get('iptv'))
    _sms_raw = _s(nm.get('sms')) or _s(nm.get('SMS')) or _s(nm.get('shortMessage'))
    f['短信'] = f'{_strip_trailing(_sms_raw, ["条"])}条' if (_sms_raw and _sms_raw not in ('0', 'null')) else ''
    f['亲情网'] = _s(nm.get('familyNet'))
    f['权益'] = _s(nm.get('rights'))
    f['超出资费说明'] = _s(nm.get('extraFees'))
    f['额外费用'] = _s(nm.get('extraFee'))
    f['其他费用'] = _s(nm.get('otherFee'))
    f['资费说明'] = _s(nm.get('tariffDesc') or nm.get('feeDesc'))
    f['其他服务内容'] = _s(nm.get('otherContent'))
    # 回退：短信字段为空时从服务内容提取（官网常把「含短信100条」写进 otherContent）。
    # 原实现误放在 其他服务内容 赋值之前，永远读到空值（死代码），移到赋值之后并先洗标签
    if not f['短信']:
        _m = re.search(r'短信\s*(\d+)\s*条', _norm_txt(f['其他服务内容']))
        if _m:
            f['短信'] = f'{_m.group(1)}条'
    f['办理说明'] = _s(nm.get('handleDesc') or nm.get('transactDesc'))
    f['其他说明'] = _s(nm.get('otherDesc'))
    f['状态'] = _s(nm.get('status') or nm.get('state'))
    f['更新时间'] = _s(nm.get('updateTime'))
    f['创建时间'] = _s(nm.get('createTime'))
    for k in FIELD_KEYS:
        if k not in f:
            f[k] = ''

    extra_keys = EXTRA_FIELD_KEYS.get(carrier, [])
    extra = {}
    for ek in extra_keys:
        if ek in nm and nm.get(ek) is not None:
            extra[ek] = _s(nm.get(ek))

    extra_other = {}
    mapped_keys = set(FIELD_KEYS) | set(extra_keys) | {
        'fees', 'feesUnit', 'reportNo', 'goodsid', 'name', 'tariffName',
        'productName', 'type1', 'productCode', 'goodsCode', 'price',
        'priceUnit', 'onlineDay', 'offineDay', 'offlineDay', 'validPeriod',
        'duration', 'applicablePeople', 'applicableArea', 'channel',
        'unsubscribe', 'responsibility', 'mutexRule', 'exclusiveRule',
        'expireRule', 'dueRule', 'accessReq', 'netInReq', 'call', 'data',
        'dataUnit', 'orientTraffic', 'orientTrafficUnit', 'areaTraffic',
        'areaTrafficUnit', 'brandwidth', 'iptv', 'sms', 'familyNet',
        'rights', 'extraFees', 'extraFee', 'otherFee', 'tariffDesc',
        'feeDesc', 'otherContent', 'handleDesc', 'transactDesc',
        'otherDesc', 'status', 'state', 'updateTime', 'createTime',
        'moduleName', 'planNo', 'tariffSeqno', 'seqno',
    }
    for k, v in nm.items():
        if k not in mapped_keys and v is not None and v != '':
            extra_other[k] = _s(v)

    # 存储层统一 HTML 清洗：官网 API 的描述类字段可能带 <p>/<br> 等标签，
    # 此前只在变更对比（_diff_fields norm=True → _norm_txt）清洗，存储仅 _s 去空白，
    # 造成「变更记录是纯文本、快照残留标签」的两张皮。此处让存储值与对比值同源清洗，
    # 也避免标签属性变化（如 <p class>）在对比时被洗掉而快照反复变动的假 diff。
    for d in (f, extra, extra_other):
        for k in d:
            d[k] = _norm_txt(d[k])

    return f, extra, extra_other


def _parse_non_module(raw, prov_code, prov_name, tariff_attr, type1, type2, cmcc_code=None, carrier='cmcc'):
    name = _s(raw.get('tariffName') or raw.get('name'))
    if not name:
        return []

    non_module_list = raw.get('nonModuleList') or []
    if not non_module_list:
        return []

    id_prefix = f'{carrier}_{prov_code}'
    flat_items = []
    for nm in non_module_list:
        sub_name = _s(nm.get('name'))
        if not sub_name:
            continue
        # tariff_attr/type1/type2 不做枚举值硬编码校验：这些是动态分类代码，
        # 由运营商 category_maps 配置决定，API 可能返回新增分类值。
        # 仅做空值回退（使用父级分类值），非空值直接透传，由前端 category_maps 映射展示。
        sub_type1 = str(nm.get('type1')) if nm.get('type1') not in (None, '') else type1
        sub_type2 = str(nm.get('type2')) if nm.get('type2') not in (None, '') else type2
        sub_attr = str(nm.get('tariffAttr')) if nm.get('tariffAttr') not in (None, '') else tariff_attr
        sub_fields, extra, extra_other = _nm_to_fields(nm, tariff_attr=sub_attr, t1=sub_type1, t2=sub_type2, carrier=carrier)
        sub_id_raw = sub_fields.get('方案编号', '') or _s(nm.get('planNo') or nm.get('tariffSeqno') or '')
        if not sub_id_raw:
            continue
        item_id = f'{id_prefix}_{sub_id_raw}'
        item = {
            'id': item_id,
            'name': sub_name,
            'series': name,
            'fields': sub_fields,
            'extra': extra,
            'extra_other': extra_other,
            'province_code': prov_code,
            'province_name': prov_name,
            'tariff_attr': sub_attr,
            'type1': sub_type1,
            'type2': sub_type2,
        }
        if nm.get('moduleName'):
            item['module'] = nm['moduleName']
        flat_items.append(item)

    return flat_items


def _parse_module_package(raw, prov_code, prov_name, tariff_attr, type1, type2, cmcc_code=None, carrier='cmcc'):
    name = _s(raw.get('tariffName') or raw.get('name'))
    if not name:
        return []

    module_list = raw.get('moduleList') or []
    if not module_list:
        return []

    id_prefix = f'{carrier}_{prov_code}'
    flat_items = []

    for mod in module_list:
        mod_name = _s(mod.get('moduleName'))
        tariff_list = mod.get('tariffList') or []
        for tf in tariff_list:
            sub_name = _s(tf.get('name') or tf.get('tariffName'))
            if not sub_name:
                continue
            # tariff_attr/type1/type2 不做枚举值硬编码校验：这些是动态分类代码，
            # 由运营商 category_maps 配置决定，API 可能返回新增分类值。
            # 仅做空值回退（使用父级分类值），非空值直接透传，由前端 category_maps 映射展示。
            sub_type1 = str(tf.get('type1')) if tf.get('type1') not in (None, '') else type1
            sub_type2 = str(tf.get('type2')) if tf.get('type2') not in (None, '') else type2
            sub_attr = str(tf.get('tariffAttr')) if tf.get('tariffAttr') not in (None, '') else tariff_attr
            sub_fields, extra, extra_other = _nm_to_fields(tf, tariff_attr=sub_attr, t1=sub_type1, t2=sub_type2, carrier=carrier)
            sub_id_raw = sub_fields.get('方案编号', '') or _s(tf.get('planNo') or tf.get('tariffSeqno') or '')
            if not sub_id_raw:
                continue
            item_id = f'{id_prefix}_{sub_id_raw}'
            item = {
                'id': item_id,
                'name': sub_name,
                'series': name,
                'fields': sub_fields,
                'extra': extra,
                'extra_other': extra_other,
                'province_code': prov_code,
                'province_name': prov_name,
                'tariff_attr': sub_attr,
                'type1': sub_type1,
                'type2': sub_type2,
            }
            if mod_name:
                item['module'] = mod_name
            flat_items.append(item)

    return flat_items


def standardize_bean(raw, prov_code, prov_name, tariff_attr, type1, type2, cmcc_code=None, carrier='cmcc'):
    has_modules = bool(raw.get('moduleList'))
    has_non_modules = bool(raw.get('nonModuleList'))

    if has_modules:
        items = _parse_module_package(raw, prov_code, prov_name, tariff_attr, type1, type2, cmcc_code=cmcc_code, carrier=carrier)
    elif has_non_modules:
        items = _parse_non_module(raw, prov_code, prov_name, tariff_attr, type1, type2, cmcc_code=cmcc_code, carrier=carrier)
    else:
        return []

    return [it for it in items if it.get('id')]


def build_snapshot(prov_code, prov_name, items, crawl_time, data_crawl_time, carrier='cmcc'):
    return {
        'version': SNAPSHOT_VERSION,
        'crawl_time': crawl_time,
        'data_crawl_time': data_crawl_time,
        'section': prov_code,
        'carrier': carrier,
        'items': items,
    }


def compute_dist(items):
    dist = {}
    for item in items:
        attr = item.get('tariff_attr', '') or '0'
        t1 = item.get('type1', '') or '0'
        t2 = item.get('type2', '') or '0'
        dist.setdefault(attr, {}).setdefault(t1, {}).setdefault(t2, 0)
        dist[attr][t1][t2] += 1
    return dist


def compute_breakdown(items):
    result = {}
    for item in items:
        attr = item.get('tariff_attr', '') or '0'
        result.setdefault(attr, {'tariffs': 0})
        result[attr]['tariffs'] += 1
    return result


# ════════════════════════════════════════════════════════════
#  核心逻辑: 变更检测、changelog 生成、stats 构建
# ════════════════════════════════════════════════════════════

_META_OVERLAP_KEYS = {'资费类型', '归属'}  # 这两个字段在 meta_diff 中用 label 映射值（如"个人资费"），field_diff 中跳过以避免重复


def _is_test_item(name, patterns):
    t = (name or '').strip()
    if not t:
        return False
    tl = t.lower()
    for p in patterns:
        if p.lower() in tl:
            return True
    return False


def _filter_test_items(items, cfg):
    ft = cfg.get('filter_test', {})
    if not ft.get('enabled', False):
        return items
    if not items:
        return items
    patterns = ft.get('patterns', [])
    exclude_patterns = ft.get('exclude_patterns', [])
    kept = []
    dropped_names = []
    for x in items:
        title = x.get('name') or x.get('title') or ''
        if _is_test_item(title, patterns):
            excluded = False
            for ep in exclude_patterns:
                if ep in title:
                    excluded = True
                    break
            if excluded:
                kept.append(x)
            else:
                dropped_names.append(title)
        else:
            kept.append(x)
    if dropped_names:
        preview = '、'.join(dropped_names[:3]) + ('…' if len(dropped_names) > 3 else '')
        logger.info(f'  [过滤] 剔除测试/作废数据 {len(dropped_names)} 条：{preview}')
    return kept


def _norm_txt(v):
    x = '' if v is None else str(v)
    x = re.sub(r'<br\s*/?>', ' ', x, flags=re.I)
    x = re.sub(r'</?p[^>]*>', ' ', x, flags=re.I)
    x = re.sub(r'<[^>]*>', '', x)
    x = re.sub(r'&(?:nbsp|amp|lt|gt|quot|#39);', ' ', x, flags=re.I)
    return re.sub(r'\s+', ' ', x).strip()


def _field_keys(items):
    for it in (items or []):
        f = it.get('fields') if isinstance(it, dict) else None
        if isinstance(f, dict):
            return tuple(sorted(f.keys()))
    return None


def _structure_upgraded(old_items, new_items):
    ok, nk = _field_keys(old_items), _field_keys(new_items)
    return ok is not None and nk is not None and ok != nk


def _diff_fields(old_fields, new_fields, norm=False):
    changes = {}
    for k in FIELD_KEYS:
        if k in _META_OVERLAP_KEYS:
            continue
        ov = old_fields.get(k, '')
        nv = new_fields.get(k, '')
        if norm:
            ov, nv = _norm_txt(ov), _norm_txt(nv)
        if ov != nv:
            changes[k] = [ov, nv]
    return changes if changes else None


# 设计决策：不引入三级 Diff 匹配（ID → stable_business_key → reportNo 辅助），原因：
#   1. ID 漂移问题在实际运行中从未发生——reportNo 是工信部备案编号，
#      同一业务上变更几乎没有先例，hunan 实际运行也从未触发 ID 漂移检测。
#   2. 即使发生 ID 漂移，现有波动检测（总量骤增→hard_reject）+ 重复率检测
#      + 人工 review 三层防线足以兜底。
#   3. diff 是变更检测核心，改造风险高——任何 bug 都会导致变更漏报或误报。
#   4. 三级匹配逻辑复杂度高（used_old/used_new 集合 + 一对一约束），维护成本大。
#   如未来确实出现 ID 漂移案例，再针对性实施，有真实数据验证改造效果。
def diff_snapshots(old_snap, new_snap, carrier='cmcc', norm=False):
    results = {'added': [], 'removed': [], 'modified': []}
    old_map = {it['id']: it for it in (old_snap.get('items') or [])}

    for item in (new_snap.get('items') or []):
        old_item = old_map.get(item['id'])

        if not old_item:
            results['added'].append({
                'id': item['id'],
                'name': item.get('name', ''),
                'series': item.get('series', ''),
                'attr': item.get('tariff_attr', ''),
                't1': item.get('type1', ''),
                't2': item.get('type2', ''),
            })
            continue

        field_diff = _diff_fields(old_item.get('fields', {}), item.get('fields', {}), norm=norm)

        meta_diff = {}
        old_name = _norm_txt(old_item.get('name', '')) if norm else old_item.get('name', '')
        new_name = _norm_txt(item.get('name', '')) if norm else item.get('name', '')
        if old_name != new_name:
            meta_diff['产品名称'] = [old_name, new_name]
        old_series = _norm_txt(old_item.get('series', '')) if norm else old_item.get('series', '')
        new_series = _norm_txt(item.get('series', '')) if norm else item.get('series', '')
        if old_series != new_series:
            meta_diff['所属系列'] = [old_series, new_series]
        if old_item.get('tariff_attr') != item.get('tariff_attr'):
            meta_diff['资费范围'] = [
                _get_attr_label(carrier, old_item.get('tariff_attr', '')),
                _get_attr_label(carrier, item.get('tariff_attr', '')),
            ]
        if old_item.get('type1') != item.get('type1'):
            meta_diff['归属'] = [
                _get_t1_label(carrier, old_item.get('type1', '')),
                _get_t1_label(carrier, item.get('type1', '')),
            ]
        if old_item.get('type2') != item.get('type2'):
            meta_diff['资费类型'] = [
                _get_t2_label(carrier, old_item.get('type2', '')),
                _get_t2_label(carrier, item.get('type2', '')),
            ]

        diff = {}
        if meta_diff:
            diff.update(meta_diff)
        if field_diff:
            diff.update(field_diff)

        if diff:
            results['modified'].append({
                'id': item['id'],
                'name': item.get('name', ''),
                'series': item.get('series', ''),
                'attr': item.get('tariff_attr', ''),
                't1': item.get('type1', ''),
                't2': item.get('type2', ''),
                'diff': diff,
            })

    new_ids = {it['id'] for it in (new_snap.get('items') or [])}
    for it in (old_snap.get('items') or []):
        if it['id'] not in new_ids:
            results['removed'].append({
                'id': it['id'],
                'name': it.get('name', ''),
                'series': it.get('series', ''),
                'attr': it.get('tariff_attr', ''),
                't1': it.get('type1', ''),
                't2': it.get('type2', ''),
                'snapshot': it.get('fields', {}),
            })

    return results


_VFR_DATE_PAT = re.compile(r"(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})")


def _parse_cn_date(s):
    if s is None:
        return None
    m = _VFR_DATE_PAT.search(str(s))
    if not m:
        return None
    try:
        return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except Exception:
        return None


def _still_onsale(item, date_field, logic):
    f = item.get('fields') if isinstance(item, dict) else None
    if not isinstance(f, dict):
        return None
    v = f.get(date_field)
    d = _parse_cn_date(v)
    if d is None:
        return None
    today = datetime.date.today()
    if logic == 'future_only':
        return d > today
    elif logic == 'future_and_today':
        return d >= today
    return None


def _drop_fake_removed(removed, old_items_map, vfr_cfg):
    vfr = vfr_cfg if vfr_cfg else {}
    if not vfr.get('enabled', True) or vfr.get('logic') == 'disabled' or not removed:
        return removed, 0
    date_field = vfr.get('date_field', '下线日期')
    logic = vfr.get('logic', 'future_only')
    kept, dropped = [], []
    for r in removed:
        old_item = old_items_map.get(r['id'])
        if old_item and _still_onsale(old_item, date_field, logic) is True:
            dropped.append(r)
        else:
            kept.append(r)
    if dropped:
        names = [r.get('name', '') for r in dropped[:3]]
        suffix = '…' if len(dropped) > 3 else ''
        logger.info(f'  剔除假下架 {len(dropped)} 条（{date_field}未到期）：{"、".join(n for n in names if n)}{suffix}')
    return kept, len(dropped)


def _is_stale_added(item, baseline_dt=None, stale_days=2):
    f = item.get('fields') if isinstance(item, dict) else None
    if not isinstance(f, dict):
        return None
    d = _parse_cn_date(f.get('上线日期'))
    if d is None:
        return None
    if baseline_dt is not None:
        return d <= baseline_dt
    return (datetime.date.today() - d).days > stale_days


def _drop_stale_added(added, new_items_map, vfr_cfg, baseline_dt=None):
    vfr = vfr_cfg if vfr_cfg else {}
    if not vfr.get('enabled', True) or vfr.get('logic') == 'disabled' or not added:
        return added, 0
    stale_days = vfr.get('stale_online_days', 2)
    real, dropped = [], []
    for a in added:
        new_item = new_items_map.get(a['id'])
        if new_item and _is_stale_added(new_item, baseline_dt, stale_days) is True:
            dropped.append(a)
        else:
            real.append(a)
    if dropped:
        names = [a.get('name', '') for a in dropped[:3]]
        suffix = '…' if len(dropped) > 3 else ''
        basis = f'上线日期早于上一轮基线 {baseline_dt}' if baseline_dt else f'上线日期早于今日 {stale_days} 天以上'
        logger.info(f'  剔除假新增 {len(dropped)} 条（{basis}，属漏采补录）：{"、".join(n for n in names if n)}{suffix}')
    return real, len(dropped)


# 设计决策：不引入 changelog 瘦身（hunan 的 slim_change），原因：
#   data-schema-v2 的 changelog 结构天然不会膨胀到 hunan 的程度：
#   1. 按条目拆分（每条 added/removed/modified 各一条 entry），
#      不存在 hunan 的 _names/_list 无限聚合问题。
#   2. 已有 retention_days=30 自动清理，hunan 无此机制。
#   3. diff 字段仅存变更字段（1-3个），非全量快照。
#   4. 当前单文件~150KB，总量~18MB（分散在124个文件），远未到需要瘦身的程度。
#   5. 截断可能影响前端展示（长文本被截断后弹窗显示不全）。
#   如未来确需瘦身，缩短 retention_days（如30→14）即可，零代码改动。
def build_changelog_entries(diff_result, timestamp):
    entries = []

    for a in diff_result.get('added', []):
        entry = {
            'ts': timestamp, 'type': 'added',
            'id': a['id'], 'name': a.get('name', ''),
            'series': a.get('series', ''),
            'attr': a.get('attr', ''),
            't1': a.get('t1', ''),
            't2': a.get('t2', ''),
        }
        entries.append(entry)

    for r in diff_result.get('removed', []):
        entry = {
            'ts': timestamp, 'type': 'removed',
            'id': r['id'], 'name': r.get('name', ''),
            'series': r.get('series', ''),
            'attr': r.get('attr', ''),
            't1': r.get('t1', ''),
            't2': r.get('t2', ''),
        }
        if r.get('snapshot') is not None:
            entry['snapshot'] = r['snapshot']
        entries.append(entry)

    for m in diff_result.get('modified', []):
        entry = {
            'ts': timestamp, 'type': 'changed',
            'id': m['id'], 'name': m.get('name', ''),
            'series': m.get('series', ''),
            'attr': m.get('attr', ''),
            't1': m.get('t1', ''),
            't2': m.get('t2', ''),
        }
        if m.get('diff'):
            entry['diff'] = m['diff']
        entries.append(entry)

    return entries


def build_stats(opts):
    crawl_time = opts['crawl_time']
    next_crawl_time = opts['next_crawl_time']
    status = opts['status']
    last_crawl_duration_ms = opts['last_crawl_duration_ms']
    carriers_data = opts['carriers']

    carriers = {}
    for carrier_key, cdata in carriers_data.items():
        province_data = cdata['province_data']
        default_province = cdata['default_province']

        provinces = []
        last_crawl = {}
        today = {}

        def _acc(target, source):
            for attr_key, counts in (source or {}).items():
                if not isinstance(counts, dict):
                    continue
                bucket = target.setdefault(attr_key, {'added': 0, 'removed': 0, 'changed': 0})
                bucket['added'] += counts.get('added', 0)
                bucket['removed'] += counts.get('removed', 0)
                bucket['changed'] += counts.get('changed', 0)

        for pd in province_data:
            bd = pd['breakdown']
            total_tariffs = sum(v.get('tariffs', 0) for v in bd.values()) if isinstance(bd, dict) else 0
            provinces.append({
                'code': pd['code'],
                'name': pd['name'],
                'total': {'tariffs': total_tariffs},
                'breakdown': bd,
                'data_crawl_time': pd['data_crawl_time'],
                'crawl_status': pd['crawl_status'],
                'volatility': pd.get('volatility'),
                'last_crawl': pd['last_crawl'],
                'today': pd['today'],
                'dist': pd['dist'],
                'consecutive_degrade_count': pd.get('consecutive_degrade_count', 0),
            })

            if pd['crawl_status'] in ('success', 'degrade_auto_recovered'):
                _acc(last_crawl, pd.get('last_crawl'))
                _acc(today, pd.get('today'))

        carriers[carrier_key] = {
            'default_province': default_province,
            # 跨省去重计数（全网+31省）：按方案编号去重（全国方案跨省同码只计一次，无编号回退名称），反映真实套餐品种数
            'total_unique': len(cdata.get('name_set') or set()),
            'last_crawl': last_crawl,
            'today': today,
            'category_maps': CARRIER_CATEGORY_MAPS.get(carrier_key, {
                'attr': {}, 't1': {}, 't2': {},
            }),
            'provinces': provinces,
        }

    return {
        'version': STATS_VERSION,
        'crawl_time': crawl_time,
        'next_crawl_time': next_crawl_time,
        'status': status,
        'last_crawl_duration_ms': last_crawl_duration_ms,
        'cache': {
            'ttl_minutes': opts.get('cache_ttl_minutes', 30),
        },
        'default_carrier': opts.get('default_carrier', 'cmcc'),
        'carriers': carriers,
    }


# ════════════════════════════════════════════════════════════
#  存储后端: Cloudflare Pages / GitHub Pages（buffer + commit 模式）
# ════════════════════════════════════════════════════════════

# ── 前端文件源（可选）：GitHub 仓库拉取，本地目录兼任缓存与回落 ──
_FRONTEND_SOURCE_DONE = False


def _frontend_extract_zip(zip_bytes, subdir, target_dir):
    """解包 GitHub zipball：提取 zip 根目录下 subdir/ 内的文件，原子替换写入 target_dir。
    原子性：先写 .fetch_tmp 临时目录，全部成功后替换旧目录——中途失败不影响既有缓存。"""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = zf.namelist()
        top = ''
        for n in names:   # zipball 顶层目录形如 {repo}-{短sha}/
            cand = n.split('/', 1)[0] + '/'
            if cand and n != cand:
                top = cand
                break
        src_prefix = (top + subdir.strip('/') + '/')
        picked = [n for n in names if n.startswith(src_prefix) and n != src_prefix]
        if not picked:
            raise ValueError(f'仓库 zip 中未找到前端目录 {subdir}/')
        tmp = target_dir.rstrip('/\\') + '.fetch_tmp'
        if os.path.isdir(tmp):
            shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp, exist_ok=True)
        try:
            for n in picked:
                rel = n[len(src_prefix):].replace('\\', '/')
                if not rel or rel.endswith('/'):
                    continue
                dest = os.path.join(tmp, *rel.split('/'))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with zf.open(n) as fsrc, open(dest, 'wb') as fdst:
                    shutil.copyfileobj(fsrc, fdst)
            if os.path.isdir(target_dir):
                shutil.rmtree(target_dir)
            os.replace(tmp, target_dir)
        except Exception:
            shutil.rmtree(tmp, ignore_errors=True)
            raise


def _ensure_frontend_source(frontend_dir_path, source_cfg):
    """前端文件来源。mode 四档（默认 github_prefer）：
      github_prefer  优先 GitHub：每次部署前拉取最新，失败回落本地既有内容（仅告警不中断）
      local_only     仅本地目录，不做任何拉取
      local_prefer   优先本地：本地目录非空直接用，为空才拉取
      github_only    仅 GitHub：必须拉取成功，失败抛错终止本轮前端部署（防发布过期缓存）
    本地目录在 GitHub 模式下兼任缓存副本（原子覆盖写入）。进程内最多处理一次。"""
    global _FRONTEND_SOURCE_DONE
    if _FRONTEND_SOURCE_DONE:
        return
    _FRONTEND_SOURCE_DONE = True
    fs = source_cfg or {}
    mode = str(fs.get('mode') or '').strip() or 'github_prefer'
    if mode not in ('github_prefer', 'local_only', 'local_prefer', 'github_only'):
        mode = 'github_prefer'
    if mode == 'local_only':
        return
    frontend_dir = os.path.abspath(frontend_dir_path)
    has_local = False
    if os.path.isdir(frontend_dir):
        has_local = any(os.listdir(frontend_dir))
    if mode == 'local_prefer' and has_local:
        return
    repo = str(fs.get('repo') or '').strip().strip('/')
    if not repo:
        if mode == 'github_only':
            raise RuntimeError('前端源模式=github_only 且未配置 frontend_source.repo，无法获取前端文件')
        logger.warning(f'前端源模式={mode} 但未配置 frontend_source.repo，回退本地前端目录')
        return
    branch = str(fs.get('branch') or 'main').strip()
    subdir = str(fs.get('subdir') or 'pages-dist').strip('/')
    url = f'https://api.github.com/repos/{repo}/zipball/{branch}'
    mirror = str(fs.get('mirror_prefix') or '').strip()
    if mirror:
        url = mirror.rstrip('/') + '/' + url
    headers = {'Authorization': f'Bearer {fs["token"]}'} if fs.get('token') else {}
    timeout = int(fs.get('timeout_sec') or 60)
    try:
        logger.info(f'GitHub 前端源[{mode}]: 拉取 {repo}@{branch} (subdir={subdir}) ...')
        resp = requests.get(url, headers=headers, timeout=timeout)
        if resp.status_code != 200:
            raise RuntimeError(f'HTTP {resp.status_code}')
        _frontend_extract_zip(resp.content, subdir, frontend_dir)
        logger.info('GitHub 前端源: 拉取成功，本地前端目录已更新')
    except Exception as e:
        if mode == 'github_only':
            raise RuntimeError(f'GitHub 前端源拉取失败(仅 GitHub 模式不回落本地): {str(e)[:120]}')
        logger.warning(f'GitHub 前端源拉取失败: {str(e)[:120]}，回退本地前端目录（上次成功内容）')


def _collect_frontend_files(frontend_dir_path, source_cfg=None):
    _ensure_frontend_source(frontend_dir_path, source_cfg)
    files = {}
    frontend_dir = os.path.abspath(frontend_dir_path)
    if not os.path.isdir(frontend_dir):
        raise FileNotFoundError(f'前端目录不存在: {frontend_dir} (include_frontend=True 时必须提供)')
    for root, dirs, fnames in os.walk(frontend_dir):
        for fname in fnames:
            fpath = os.path.join(root, fname)
            rel_path = os.path.relpath(fpath, frontend_dir).replace('\\', '/')
            with open(fpath, 'rb') as f:
                files[rel_path] = f.read()
    logger.info(f'前端文件收集: {len(files)} 个文件')
    return files


class StorageBackend:
    def __init__(self):
        self.carrier_key = 'cmcc'
        self.all_carrier_keys = ['cmcc']
        self.all_active_provinces = {}
        self._local_cache_enabled = False
        self._local_cache_dir = ''
        self._manifest_cache_enabled = False
        # 多通道部署：MultiStorage 在 commit 前写入线路清单，各线 commit 时注入 index.html；
        # None = 不注入（本地开发/未启用多通道时占位符原样保留，前端守卫自动不动作）
        self.route_manifest = None
        # manifest 缓存文件名按线隔离（CF 保持原名兼容存量缓存，其他线带后缀）
        self.manifest_cache_name = 'deploy_manifest.json'

    def set_carrier_key(self, carrier_key):
        self.carrier_key = carrier_key

    def set_all_carrier_keys(self, keys):
        self.all_carrier_keys = list(keys)

    def set_active_provinces(self, carrier_key, province_codes):
        self.all_active_provinces[carrier_key] = set(province_codes)

    def _get_active_province_codes(self, carrier_key):
        codes = self.all_active_provinces.get(carrier_key)
        if codes is None:
            return {p['code'] for p in PROVINCES}
        return codes

    def _init_local_cache(self, config):
        lc = (config.get('storage') or {}).get('local_cache') or {}
        self._local_cache_enabled = bool(lc.get('enabled', False))
        path = (lc.get('path') or '').strip()
        if not path:
            path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'local_cache')
        self._local_cache_dir = os.path.abspath(path)
        mc = (config.get('storage') or {}).get('manifest_cache') or {}
        self._manifest_cache_enabled = bool(mc.get('enabled', True))

    def _local_read(self, key):
        if not self._local_cache_enabled:
            return None
        fpath = os.path.join(self._local_cache_dir, self.path_prefix, key)
        if not os.path.isfile(fpath):
            return None
        try:
            with open(fpath, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return None

    def _local_write(self, key, data):
        if not self._local_cache_enabled:
            return
        fpath = os.path.join(self._local_cache_dir, self.path_prefix, key)
        os.makedirs(os.path.dirname(fpath), exist_ok=True)
        tmp = fpath + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        os.replace(tmp, fpath)

    def _cleanup_local_cache(self):
        if not self._local_cache_enabled:
            return
        base = os.path.join(self._local_cache_dir, self.path_prefix)
        if not os.path.isdir(base):
            return
        for carrier_key in os.listdir(base):
            carrier_dir = os.path.join(base, carrier_key)
            if not os.path.isdir(carrier_dir):
                continue
            if carrier_key not in self.all_carrier_keys:
                shutil.rmtree(carrier_dir, ignore_errors=True)
                continue
            if carrier_key not in self.all_active_provinces:
                shutil.rmtree(carrier_dir, ignore_errors=True)
                continue
            active_codes = self._get_active_province_codes(carrier_key)
            for subdir in ('snapshots', 'changelogs'):
                subdir_path = os.path.join(carrier_dir, subdir)
                if not os.path.isdir(subdir_path):
                    continue
                for fname in os.listdir(subdir_path):
                    code = fname.replace('snapshot_', '').replace('changelog_', '').replace('.json', '')
                    if code not in active_codes:
                        os.remove(os.path.join(subdir_path, fname))

    def _local_has_file(self, key):
        if not self._local_cache_enabled:
            return False
        fpath = os.path.join(self._local_cache_dir, self.path_prefix, key)
        return os.path.isfile(fpath)

    def _read_manifest_cache(self):
        if not self._manifest_cache_enabled:
            return None
        fpath = os.path.join(self._local_cache_dir, self.manifest_cache_name)
        if not os.path.isfile(fpath):
            return None
        try:
            with open(fpath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if data.get('version') == 1 and isinstance(data.get('manifest'), dict):
                return data['manifest']
            return None
        except Exception:
            return None

    def _write_manifest_cache(self, manifest):
        if not self._manifest_cache_enabled:
            return
        fpath = os.path.join(self._local_cache_dir, self.manifest_cache_name)
        os.makedirs(os.path.dirname(fpath), exist_ok=True)
        with open(fpath, 'w', encoding='utf-8') as f:
            json.dump({'version': 1, 'manifest': manifest}, f, ensure_ascii=False, indent=2)

    def read_json(self, key):
        raise NotImplementedError

    def write_json(self, key, data):
        raise NotImplementedError

    def write_bytes(self, key, data):
        """二进制文件写入 buffer（站点图标等静态资源；持久副本由调用方维护在
        local_cache/favicons/，不走 JSON 本地缓存）。三条部署通道的 files 字典
        均直接收 bytes，无需各线单独适配。"""
        self._buffer[f'{self.path_prefix}/{key}'] = data

    def list_keys(self, prefix=''):
        raise NotImplementedError

    def commit(self, message='auto update', skip_unchanged_download=False):
        raise NotImplementedError

    def merge_buffer(self, other):
        raise NotImplementedError

    # ── 多通道：线路清单注入（index.html 占位符替换）──
    ROUTES_PLACEHOLDER = 'window.__ROUTES__=null'

    def _inject_routes(self, files):
        """commit 前调用：把 index.html 中的 __ROUTES__ 占位替换为本线携带的完整线路清单。
        route_manifest 为 None（本地开发/单线未配置清单）时不注入，前端守卫读到 null 自动不动作。"""
        if self.route_manifest is None:
            return
        html = files.get('index.html')
        if html is None:
            return
        payload = 'window.__ROUTES__=' + json.dumps(
            self.route_manifest, ensure_ascii=False, separators=(',', ':'))
        text = html.decode('utf-8')
        if self.ROUTES_PLACEHOLDER not in text:
            logger.warning('存储层: index.html 未找到 __ROUTES__ 占位符，跳过线路清单注入')
            return
        files['index.html'] = text.replace(self.ROUTES_PLACEHOLDER, payload, 1).encode('utf-8')
        logger.debug(f'存储层: __ROUTES__ 已注入 ({len(self.route_manifest.get("fallbacks") or [])} 条备线)')


class CloudflareStorage(StorageBackend):
    def __init__(self, config):
        super().__init__()
        cf = config['storage']['cloudflare']
        self.account_id = cf['account_id']
        self.project_name = cf['project_name']
        self.api_token = cf['api_token']
        self.domain = cf.get('domain', '').rstrip('/')
        assert self.domain, 'storage.cloudflare.domain 不能为空，否则无法读取旧数据做对比'
        self.path_prefix = cf.get('path', 'data').strip('/')
        self.include_frontend = cf.get('include_frontend', True)
        fs_src = (config.get('storage') or {}).get('frontend_source') or {}
        # 全局前端目录优先（storage.frontend_source.frontend_dir），各线历史遗留 frontend_dir 作回退
        self.frontend_dir = str(fs_src.get('frontend_dir') or '').strip() or cf.get('frontend_dir') or './pages-dist'
        self.frontend_source = fs_src
        self.api_base = 'https://api.cloudflare.com/client/v4'
        self.session = requests.Session()
        self.session.headers.update({'Authorization': f'Bearer {self.api_token}'})
        self._buffer = {}
        self.production_branch = 'main'
        self._init_local_cache(config)
        logger.info(f'Cloudflare 存储初始化: account={self.account_id}, project={self.project_name}')

    def merge_buffer(self, other):
        self._buffer.update(other._buffer)

    def read_json(self, key):
        buf_key = f'{self.path_prefix}/{key}'
        if buf_key in self._buffer:
            return json.loads(self._buffer[buf_key].decode('utf-8'))
        local_data = self._local_read(key)
        if local_data is not None:
            return local_data
        if self.domain:
            url = f'{self.domain}/{self.path_prefix}/{key}'
            last_err = None
            for attempt in range(3):
                try:
                    resp = self.session.get(url, timeout=30)
                    if resp.status_code == 200:
                        try:
                            return resp.json()
                        except (json.JSONDecodeError, ValueError):
                            logger.debug(f'Cloudflare: {key} 响应非JSON内容（SPA回退），视为不存在')
                            return None
                    if resp.status_code == 404:
                        return None
                    last_err = f'HTTP {resp.status_code}'
                except Exception as e:
                    last_err = str(e)
                    if isinstance(e, (requests.exceptions.SSLError, requests.exceptions.ConnectionError)):
                        try:
                            self.session.close()
                        except Exception:
                            pass
                        self.session = requests.Session()
                        self.session.headers.update({'Authorization': f'Bearer {self.api_token}'})
                if attempt < 2:
                    time.sleep(1 + attempt)
            raise RuntimeError(f'读取 {key} 失败（重试3次）: {last_err}')
        logger.debug(f'Cloudflare: 无法读取 {key}（无自定义域名或域名不可达），返回 None')
        return None

    def write_json(self, key, data):
        body = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self._buffer[f'{self.path_prefix}/{key}'] = body
        self._local_write(key, data)
        logger.debug(f'Cloudflare buffer 写入: {self.path_prefix}/{key} ({len(body)} bytes)')

    def _ensure_project(self):
        url = f'{self.api_base}/accounts/{self.account_id}/pages/projects/{self.project_name}'
        resp = self.session.get(url, timeout=30)
        if resp.status_code == 200:
            try:
                self.production_branch = (resp.json().get('result') or {}).get('production_branch') or 'main'
            except Exception:
                self.production_branch = 'main'
            return
        if resp.status_code == 404:
            create_url = f'{self.api_base}/accounts/{self.account_id}/pages/projects'
            create_resp = self.session.post(
                create_url,
                json={'name': self.project_name, 'production_branch': 'main'},
                timeout=30,
            )
            if not create_resp.ok or not create_resp.json().get('success'):
                raise RuntimeError(
                    f'Cloudflare: Pages 项目 {self.project_name} 不存在且自动创建失败 '
                    f'(HTTP {create_resp.status_code}): {create_resp.text}'
                )
            try:
                self.production_branch = (create_resp.json().get('result') or {}).get('production_branch') or 'main'
            except Exception:
                self.production_branch = 'main'
            logger.info(f'Cloudflare: Pages 项目 {self.project_name} 已自动创建')
        else:
            raise RuntimeError(
                f'Cloudflare: 查询 Pages 项目 {self.project_name} 失败 '
                f'(HTTP {resp.status_code}): {resp.text}'
            )

    def _buffer_local_sync(self, rel_path, content):
        """buffer 数据文件回写本地前端目录（{frontend_dir}/{rel_path}）：github_only 拉取是清空式
        替换且仓库不含 data 文件，回写保证 localhost 测试环境与线上部署完全同源
        （快照/变更/公告/公共配置/烘焙一视同仁）。尽力而为：失败仅告警，不影响部署。"""
        prefix = f'{self.path_prefix}/'
        if not rel_path.startswith(prefix) or not self.frontend_dir:
            return
        try:
            fpath = os.path.join(os.path.abspath(self.frontend_dir), rel_path)
            os.makedirs(os.path.dirname(fpath), exist_ok=True)
            tmp = fpath + '.tmp'
            with open(tmp, 'wb') as f:
                f.write(content)
            os.replace(tmp, fpath)
        except Exception as e:
            logger.warning(f'Cloudflare: 本地数据副本 {rel_path} 回写失败(不影响部署): {str(e)[:80]}')

    def commit(self, message='auto update', skip_unchanged_download=False):
        self._ensure_project()

        files = {}
        if self.include_frontend:
            files.update(_collect_frontend_files(self.frontend_dir, self.frontend_source))
        for rel_path, content in self._buffer.items():
            files[rel_path] = content
            self._buffer_local_sync(rel_path, content)
        self._inject_routes(files)

        cached_manifest = {}
        if skip_unchanged_download and self._manifest_cache_enabled:
            cached_manifest = self._read_manifest_cache() or {}
        cached_hashes = {}

        # 兜底补全：仅对仍在采集目标中的省份保留旧数据。
        # 未配置的省份不补全 → Cloudflare 全量替换时自动删除其 snapshot/changelog。
        # 已禁用的运营商：删除其全部省份数据。
        # failed/error/abnormal skip/compare_only/hard_reject/can_overwrite=False 等
        # 分支的省份仍保留旧版数据，避免被误删。
        deleted_count = 0
        for carrier_key in self.all_carrier_keys:
            enabled = carrier_key in self.all_active_provinces
            if not enabled:
                for prov in PROVINCES:
                    for key in (
                        f'{carrier_key}/snapshots/snapshot_{prov["code"]}.json',
                        f'{carrier_key}/changelogs/changelog_{prov["code"]}.json',
                    ):
                        rel = f'{self.path_prefix}/{key}'
                        if rel in files:
                            del files[rel]
                            deleted_count += 1
                continue
            # announce.json 兜底补全（与 EdgeOneStorage 同语义）：--deploy-frontend 等模式
            # buffer 无公告数据，全量替换制下缺它 = 线上公告被删 → 公告页签「暂无公告源」
            ann_rel = f'{self.path_prefix}/{carrier_key}/announce.json'
            if ann_rel not in files:
                ann_manifest_key = f'/{ann_rel}'
                if skip_unchanged_download and ann_manifest_key in cached_manifest:
                    cached_hashes[ann_rel] = cached_manifest[ann_manifest_key]
                else:
                    try:
                        old_ann = self.read_json(f'{carrier_key}/announce.json')
                    except RuntimeError as e:
                        logger.warning(f'Cloudflare: 补全旧公告失败 ({carrier_key}): {e}')
                        old_ann = None
                    if old_ann is not None:
                        files[ann_rel] = json.dumps(old_ann, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            # 社区内容静态化兜底（acts/chats，同 announce 语义）：轻量轮 buffer 无烘焙数据，
            # 全量替换制下缺它 = 线上文件被删 → 前端回落 Worker API 前多一次 404
            # ▸ 目录名 = 资费口径（2026-10 口径统一后与 bake_community_data 产出的文件名一致）
            hub_key = carrier_key
            for bake_key in (f'{hub_key}/acts.json', f'{hub_key}/chats.json'):
                bake_rel = f'{self.path_prefix}/{bake_key}'
                if bake_rel not in files:
                    bake_manifest_key = f'/{bake_rel}'
                    if skip_unchanged_download and bake_manifest_key in cached_manifest:
                        cached_hashes[bake_rel] = cached_manifest[bake_manifest_key]
                    else:
                        try:
                            old_bake = self.read_json(bake_key)
                        except RuntimeError as e:
                            logger.warning(f'Cloudflare: 补全旧社区数据失败 ({bake_key}): {e}')
                            old_bake = None
                        if old_bake is not None:
                            files[bake_rel] = json.dumps(old_bake, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            active_codes = self._get_active_province_codes(carrier_key)
            for prov in PROVINCES:
                if prov['code'] not in active_codes:
                    for key in (
                        f'{carrier_key}/snapshots/snapshot_{prov["code"]}.json',
                        f'{carrier_key}/changelogs/changelog_{prov["code"]}.json',
                    ):
                        rel = f'{self.path_prefix}/{key}'
                        if rel in files:
                            del files[rel]
                            deleted_count += 1
                    continue
                for key in (
                    f'{carrier_key}/snapshots/snapshot_{prov["code"]}.json',
                    f'{carrier_key}/changelogs/changelog_{prov["code"]}.json',
                ):
                    rel = f'{self.path_prefix}/{key}'
                    if rel not in files:
                        if skip_unchanged_download and self._local_cache_enabled and self._local_has_file(key):
                            try:
                                old_data = self.read_json(key)
                            except RuntimeError as e:
                                logger.warning(f'Cloudflare: 补全旧数据失败 ({key}): {e}')
                                old_data = None
                            if old_data is not None:
                                files[rel] = json.dumps(old_data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                                continue
                        manifest_key = f'/{rel}'
                        if skip_unchanged_download and manifest_key in cached_manifest:
                            cached_hashes[rel] = cached_manifest[manifest_key]
                            continue
                        try:
                            old_data = self.read_json(key)
                        except RuntimeError as e:
                            logger.warning(f'Cloudflare: 补全旧数据失败 ({key}): {e}')
                            old_data = None
                        if old_data is not None:
                            files[rel] = json.dumps(old_data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')

        stats_rel = f'{self.path_prefix}/stats.json'
        if stats_rel not in files:
            stats_manifest_key = f'/{stats_rel}'
            if skip_unchanged_download and stats_manifest_key in cached_manifest:
                cached_hashes[stats_rel] = cached_manifest[stats_manifest_key]
            else:
                try:
                    old_stats = self.read_json('stats.json')
                except RuntimeError as e:
                    logger.warning(f'Cloudflare: 补全旧 stats 失败: {e}')
                    old_stats = None
                if old_stats is not None:
                    files[stats_rel] = json.dumps(old_stats, ensure_ascii=False, separators=(',', ':')).encode('utf-8')

        tools_rel = f'{self.path_prefix}/tools.json'
        if tools_rel not in files:
            tools_manifest_key = f'/{tools_rel}'
            if skip_unchanged_download and tools_manifest_key in cached_manifest:
                cached_hashes[tools_rel] = cached_manifest[tools_manifest_key]
            else:
                try:
                    old_tools = self.read_json('tools.json')
                except RuntimeError as e:
                    logger.warning(f'Cloudflare: 补全旧社区工具数据失败: {e}')
                    old_tools = None
                if old_tools is not None:
                    files[tools_rel] = json.dumps(old_tools, ensure_ascii=False, separators=(',', ':')).encode('utf-8')

        if deleted_count:
            logger.info(f'Cloudflare: 清理 {deleted_count} 个非配置省份数据文件')

        if not files and not cached_hashes:
            logger.warning('Cloudflare: 无文件需要部署')
            return

        logger.info(f'Cloudflare: 准备部署 {len(files)} 个文件...')

        # 两阶段 Direct Upload（与 wrangler 内部实现一致，实测验证）：
        # 阶段1 资产上传：内容寻址存储，key = MD5(内容) hex，JSON 载荷 base64 编码
        # 阶段2 创建部署：multipart 仅含 manifest（路径→MD5 映射）+ branch

        def _get_upload_jwt():
            last_err = None
            for attempt in range(3):
                try:
                    resp = self.session.get(
                        f'{self.api_base}/accounts/{self.account_id}/pages/projects/{self.project_name}/upload-token',
                        timeout=30,
                    )
                    resp.raise_for_status()
                    jwt = (resp.json().get('result') or {}).get('jwt')
                    if not jwt:
                        raise RuntimeError(f'Cloudflare: 获取 upload-token 失败: {resp.text}')
                    return jwt
                except Exception as e:
                    last_err = str(e)
                    if isinstance(e, (requests.exceptions.SSLError, requests.exceptions.ConnectionError)):
                        try:
                            self.session.close()
                        except Exception:
                            pass
                        self.session = requests.Session()
                        self.session.headers.update({'Authorization': f'Bearer {self.api_token}'})
                if attempt < 2:
                    time.sleep(1 + attempt)
            raise RuntimeError(f'Cloudflare: 获取 upload-token 失败（重试3次）: {last_err}')

        jwt = _get_upload_jwt()

        manifest = {}
        file_map = {}
        for rel_path, content in files.items():
            h = hashlib.md5(content).hexdigest()
            manifest[f'/{rel_path}'] = h
            if h not in file_map:
                file_map[h] = (rel_path, content)
        for rel_path, h in cached_hashes.items():
            manifest[f'/{rel_path}'] = h

        # 查询服务端已缓存的哈希，跳过重复上传
        to_upload = list(file_map.items())
        try:
            cm_resp = self.session.post(
                f'{self.api_base}/pages/assets/check-missing',
                json={'hashes': list(file_map.keys())},
                headers={'Authorization': f'Bearer {jwt}'},
                timeout=30,
            )
            if cm_resp.ok and cm_resp.json().get('success'):
                missing = set(cm_resp.json().get('result') or file_map.keys())
                to_upload = [(h, v) for h, v in file_map.items() if h in missing]
        except Exception as e:
            logger.warning(f'Cloudflare: check-missing 失败（将全量上传）: {e}')
        logger.info(f'Cloudflare: 待上传资产 {len(to_upload)}/{len(file_map)}（缓存命中 {len(file_map) - len(to_upload)}）')

        # 分桶上传（按大小降序装箱，约 40MB/桶）
        to_upload.sort(key=lambda kv: len(kv[1][1]), reverse=True)
        buckets, cur, cur_size = [], [], 0
        for h, (rel_path, content) in to_upload:
            if cur and cur_size + len(content) > 40 * 1024 * 1024:
                buckets.append(cur)
                cur, cur_size = [], 0
            cur.append((h, rel_path, content))
            cur_size += len(content)
        if cur:
            buckets.append(cur)

        for bucket in buckets:
            # 桶级重试（指数退避 5/15/45s ±20% 抖动，共 4 次尝试）：全量采集轮待上传资产可达
            # 100+，upload 批次处理时间长，青龙直连 api.cloudflare.com 的链路间歇抖动会撞
            # 524（CF 后端 >100s 超时）——524 属超时型错误，退避后重试成功率高；每次重试
            # 重新取 JWT，防旧 token 在长等待后失效。
            up_ok = False
            last_up_err = None
            for attempt in range(4):
                try:
                    jwt = _get_upload_jwt()
                    payload = [
                        {
                            'key': h,
                            'value': base64.b64encode(content).decode('ascii'),
                            'metadata': {'contentType': mimetypes.guess_type(rel_path)[0] or 'application/octet-stream'},
                            'base64': True,
                        }
                        for h, rel_path, content in bucket
                    ]
                    up_resp = self.session.post(
                        f'{self.api_base}/pages/assets/upload',
                        json=payload,
                        headers={'Authorization': f'Bearer {jwt}'},
                        timeout=300,
                    )
                    up_resp.raise_for_status()
                    up_data = up_resp.json()
                    if not up_data.get('success'):
                        raise RuntimeError(f'Cloudflare: 资产上传失败: {json.dumps(up_data.get("errors", []), ensure_ascii=False)}')
                    failed = (up_data.get('result') or {}).get('unsuccessful_keys') or []
                    if failed:
                        raise RuntimeError(f'Cloudflare: 部分资产上传失败: {failed}')
                    up_ok = True
                    break
                except Exception as e:
                    up_ok = False
                    last_up_err = e
                    if attempt < 3:
                        wait = [5, 15, 45][attempt] * (0.8 + 0.4 * random.random())
                        logger.warning(f'Cloudflare: 资产上传第 {attempt + 1} 次失败({len(bucket)} 个资产): {str(e)[:120]}，{wait:.0f}s 后重试')
                        time.sleep(wait)
            if not up_ok:
                raise last_up_err

        # 登记哈希缓存供下次部署命中（失败不影响部署）
        try:
            jwt = _get_upload_jwt()
            self.session.post(
                f'{self.api_base}/pages/assets/upsert-hashes',
                json={'hashes': list(file_map.keys())},
                headers={'Authorization': f'Bearer {jwt}'},
                timeout=30,
            )
        except Exception:
            pass

        # 阶段2 创建部署（manifest + branch → production）
        boundary = '----WebKitFormBoundary' + uuid.uuid4().hex
        body = (
            f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="branch"\r\n\r\n'
            f'{self.production_branch}\r\n'
            f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="manifest"\r\n'
            f'Content-Type: application/json\r\n\r\n'
            f'{json.dumps(manifest)}\r\n'
            f'--{boundary}--\r\n'
        ).encode('utf-8')

        url = f'{self.api_base}/accounts/{self.account_id}/pages/projects/{self.project_name}/deployments'
        headers = {'Content-Type': f'multipart/form-data; boundary={boundary}'}
        resp = self.session.post(url, headers=headers, data=body, timeout=120)
        resp.raise_for_status()
        resp_data = resp.json()
        if not resp_data.get('success'):
            raise RuntimeError(f'Cloudflare: 部署失败: {json.dumps(resp_data.get("errors", []), ensure_ascii=False)}')
        self._buffer.clear()
        deploy_url = (resp_data.get('result') or {}).get('url', '')
        self._cleanup_local_cache()
        self._write_manifest_cache(manifest)
        total_files = len(files) + len(cached_hashes)
        logger.info(f'Cloudflare: 部署成功, {total_files} 个文件（manifest 缓存 {len(cached_hashes)}）, 默认URL: {deploy_url}, 自定义域名: {self.domain}')

    def list_keys(self, prefix=''):
        return []


class GitHubStorage(StorageBackend):
    def __init__(self, config):
        super().__init__()
        gh = config['storage']['github']
        self.token = gh['token']
        self.repo = gh['repo']
        self.branch = gh.get('branch', 'main')
        self.path_prefix = gh.get('path', 'data').strip('/')
        self.domain = gh.get('domain', '').rstrip('/')
        self.include_frontend = gh.get('include_frontend', True)
        fs_src = (config.get('storage') or {}).get('frontend_source') or {}
        # 全局前端目录优先（storage.frontend_source.frontend_dir），各线历史遗留 frontend_dir 作回退
        self.frontend_dir = str(fs_src.get('frontend_dir') or '').strip() or gh.get('frontend_dir') or './pages-dist'
        self.frontend_source = fs_src
        # 启用 GitHub Pages 自定义域时置 true：commit 随站点根提交 CNAME 文件
        self.cname_file = bool(gh.get('cname_file', False))
        self.api_base = 'https://api.github.com'
        self.session = requests.Session()
        self.session.headers.update({
            'Authorization': f'token {self.token}',
            'Accept': 'application/vnd.github.v3+json',
        })
        self._buffer = {}
        self._init_local_cache(config)
        logger.info(f'GitHub 存储初始化: repo={self.repo}, branch={self.branch}')

    def merge_buffer(self, other):
        self._buffer.update(other._buffer)

    def _api_url(self, github_path):
        return f'{self.api_base}/repos/{self.repo}/contents/{github_path}'

    def read_json(self, key):
        # buffer 优先（同 CloudflareStorage：保证 today 统计读到本轮最新 changelog）
        buf_key = f'{self.path_prefix}/{key}'
        if buf_key in self._buffer:
            return json.loads(self._buffer[buf_key].decode('utf-8'))
        local_data = self._local_read(key)
        if local_data is not None:
            return local_data
        if self.domain:
            url = f'{self.domain}/{self.path_prefix}/{key}'
            try:
                resp = self.session.get(url, timeout=30)
                if resp.status_code == 200:
                    try:
                        return resp.json()
                    except (json.JSONDecodeError, ValueError):
                        logger.debug(f'GitHub: {key} 响应非JSON内容（SPA回退），视为不存在')
                        return None
                if resp.status_code == 404:
                    return None
            except Exception as e:
                logger.warning(f'GitHub 域名读取失败 ({key}): {e}')
        try:
            gh_path = f'{self.path_prefix}/{key}'
            url = self._api_url(gh_path)
            resp = self.session.get(url, params={'ref': self.branch}, timeout=30)
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            content = base64.b64decode(resp.json()['content'])
            return json.loads(content.decode('utf-8'))
        except Exception as e:
            raise RuntimeError(f'GitHub 读取失败 ({key}): {e}')

    def write_json(self, key, data):
        body = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self._buffer[f'{self.path_prefix}/{key}'] = body
        self._local_write(key, data)
        logger.debug(f'GitHub buffer 写入: {self.path_prefix}/{key} ({len(body)} bytes)')

    def commit(self, message='auto update', skip_unchanged_download=False):
        files = {}
        if self.include_frontend:
            files.update(_collect_frontend_files(self.frontend_dir, self.frontend_source))
        for rel_path, content in self._buffer.items():
            files[rel_path] = content
        self._inject_routes(files)
        # GitHub Pages 自定义域：需在站点根提交 CNAME 文件（域名验证），启用 GH 线时由配置开启
        if self.include_frontend and self.cname_file and self.domain:
            cname_host = self.domain.replace('https://', '').replace('http://', '')
            files['CNAME'] = (cname_host + '\n').encode('utf-8')

        # 兜底补全：仅对仍在采集目标中的省份保留旧数据。
        # 未配置的省份不在 files 中，并在后续 tree_items 中标记删除。
        # 已禁用的运营商：删除其全部省份数据。
        to_delete = []
        for carrier_key in self.all_carrier_keys:
            enabled = carrier_key in self.all_active_provinces
            if not enabled:
                for prov in PROVINCES:
                    for key in (
                        f'{carrier_key}/snapshots/snapshot_{prov["code"]}.json',
                        f'{carrier_key}/changelogs/changelog_{prov["code"]}.json',
                    ):
                        rel = f'{self.path_prefix}/{key}'
                        if rel in files:
                            del files[rel]
                        try:
                            old_data = self.read_json(key)
                        except RuntimeError as e:
                            logger.warning(f'GitHub: 读取旧数据失败 ({key}): {e}')
                            old_data = None
                        if old_data is not None:
                            to_delete.append(rel)
                continue
            active_codes = self._get_active_province_codes(carrier_key)
            for prov in PROVINCES:
                if prov['code'] not in active_codes:
                    for key in (
                        f'{carrier_key}/snapshots/snapshot_{prov["code"]}.json',
                        f'{carrier_key}/changelogs/changelog_{prov["code"]}.json',
                    ):
                        rel = f'{self.path_prefix}/{key}'
                        if rel in files:
                            del files[rel]
                        try:
                            old_data = self.read_json(key)
                        except RuntimeError as e:
                            logger.warning(f'GitHub: 读取旧数据失败 ({key}): {e}')
                            old_data = None
                        if old_data is not None:
                            to_delete.append(rel)
                    continue
                for key in (
                    f'{carrier_key}/snapshots/snapshot_{prov["code"]}.json',
                    f'{carrier_key}/changelogs/changelog_{prov["code"]}.json',
                ):
                    rel = f'{self.path_prefix}/{key}'
                    if rel not in files:
                        try:
                            old_data = self.read_json(key)
                        except RuntimeError as e:
                            logger.warning(f'GitHub: 补全旧数据失败 ({key}): {e}')
                            old_data = None
                        if old_data is not None:
                            files[rel] = json.dumps(old_data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')

        if not files and not to_delete:
            logger.warning('GitHub: 无文件需要提交')
            return

        logger.info(f'GitHub: 准备提交 {len(files)} 个文件, 删除 {len(to_delete)} 个文件...')

        ref_url = f'{self.api_base}/repos/{self.repo}/git/ref/heads/{self.branch}'
        ref_resp = self.session.get(ref_url, timeout=30)
        ref_resp.raise_for_status()
        current_sha = ref_resp.json()['object']['sha']

        commit_url = f'{self.api_base}/repos/{self.repo}/git/commits/{current_sha}'
        commit_resp = self.session.get(commit_url, timeout=30)
        commit_resp.raise_for_status()
        base_tree_sha = commit_resp.json()['tree']['sha']

        tree_items = []
        for rel_path, content in files.items():
            blob_resp = self.session.post(
                f'{self.api_base}/repos/{self.repo}/git/blobs',
                json={'content': base64.b64encode(content).decode('utf-8'), 'encoding': 'base64'},
                timeout=30,
            )
            blob_resp.raise_for_status()
            tree_items.append({
                'path': rel_path,
                'mode': '100644',
                'type': 'blob',
                'sha': blob_resp.json()['sha'],
            })

        for rel_path in to_delete:
            tree_items.append({
                'path': rel_path,
                'mode': '100644',
                'type': 'blob',
                'sha': None,
            })

        tree_resp = self.session.post(
            f'{self.api_base}/repos/{self.repo}/git/trees',
            json={'base_tree': base_tree_sha, 'tree': tree_items},
            timeout=30,
        )
        tree_resp.raise_for_status()
        new_tree_sha = tree_resp.json()['sha']

        new_commit_resp = self.session.post(
            f'{self.api_base}/repos/{self.repo}/git/commits',
            json={'message': message, 'tree': new_tree_sha, 'parents': [current_sha]},
            timeout=30,
        )
        new_commit_resp.raise_for_status()
        new_commit_sha = new_commit_resp.json()['sha']

        update_resp = self.session.patch(
            ref_url,
            json={'sha': new_commit_sha, 'force': False},
            timeout=30,
        )
        update_resp.raise_for_status()
        self._buffer.clear()
        self._cleanup_local_cache()
        logger.info(f'GitHub: 提交成功, {len(files)} 个文件, commit={new_commit_sha[:7]}')

    def list_keys(self, prefix=''):
        try:
            gh_path = f'{self.path_prefix}/{prefix}'.rstrip('/')
            url = self._api_url(gh_path)
            resp = self.session.get(url, params={'ref': self.branch}, timeout=30)
            if resp.status_code != 200:
                return []
            return [item['name'] for item in resp.json() if isinstance(item, dict)]
        except Exception as e:
            logger.warning(f'GitHub 列举失败 (prefix={prefix}): {e}')
            return []


# ════════════════════════════════════════════════════════════
#  EdgeOne Pages（Makers）直传通道 + 多通道编排（MultiStorage）
# ──────────────────────────────────────────────────────────────
#  ▸ EdgeOne 线：读取基线走自定义域 HTTP，推送走 edgeone CLI 免浏览器 token 部署
#    （`edgeone pages deploy <dir> -n <项目名> -t <token>`，CLI≥1.2.30，环境需 node + npm i -g edgeone）
#  ▸ CLI 直传为整站替换语义：本次不写入的路径 = 线上删除（与 CF 全量替换一致）
#  ▸ MultiStorage：基线读写走 primary 线，commit 遍历全部 enabled 线逐个推送，单线失败仅告警
#  ▸ 缓存策略：edgeone.json 为 pages-dist 中的实体文件（与 CF 的 _headers 并排、互相独立），
#    随前端收集自动带上，无需部署端动态生成
# ════════════════════════════════════════════════════════════


class EdgeOneStorage(StorageBackend):
    manifest_cache_name = 'deploy_manifest_edgeone.json'  # 全量直传不依赖 manifest，命名隔离防呆

    def __init__(self, config):
        super().__init__()
        eo = config['storage']['edgeone']
        self.project_name = eo['project_name']
        # api_token 可空：本机已 edgeone login 时走 CLI 本地凭证；青龙等无浏览器环境必须填 API Token
        self.api_token = (eo.get('api_token') or '').strip()
        self.domain = (eo.get('domain') or '').rstrip('/')
        assert self.domain, 'storage edgeone.domain 不能为空（读取基线通道）'
        self.path_prefix = eo.get('path', 'data').strip('/')
        self.include_frontend = eo.get('include_frontend', True)
        fs_src = (config.get('storage') or {}).get('frontend_source') or {}
        # 全局前端目录优先（storage.frontend_source.frontend_dir），各线历史遗留 frontend_dir 作回退
        self.frontend_dir = str(fs_src.get('frontend_dir') or '').strip() or eo.get('frontend_dir') or './pages-dist'
        self.frontend_source = fs_src
        self.cli = (eo.get('cli') or 'edgeone').strip()
        self.deploy_timeout = int(eo.get('deploy_timeout', 600))
        self.session = requests.Session()
        self._buffer = {}
        self._init_local_cache(config)
        logger.info(f'EdgeOne 存储初始化: project={self.project_name}, domain={self.domain}')

    def merge_buffer(self, other):
        self._buffer.update(other._buffer)

    def read_json(self, key):
        buf_key = f'{self.path_prefix}/{key}'
        if buf_key in self._buffer:
            return json.loads(self._buffer[buf_key].decode('utf-8'))
        local_data = self._local_read(key)
        if local_data is not None:
            return local_data
        url = f'{self.domain}/{self.path_prefix}/{key}'
        try:
            resp = self.session.get(url, timeout=30)
            if resp.status_code == 200:
                try:
                    return resp.json()
                except (json.JSONDecodeError, ValueError):
                    logger.debug(f'EdgeOne: {key} 响应非JSON内容（SPA回退），视为不存在')
                    return None
            if resp.status_code == 404:
                return None
            logger.warning(f'EdgeOne: 读取 {key} 异常 HTTP {resp.status_code}')
            return None
        except Exception as e:
            logger.warning(f'EdgeOne: 读取 {key} 失败: {e}')
            return None

    def write_json(self, key, data):
        body = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self._buffer[f'{self.path_prefix}/{key}'] = body
        self._local_write(key, data)
        logger.debug(f'EdgeOne buffer 写入: {self.path_prefix}/{key} ({len(body)} bytes)')

    def _cli_deploy(self, src_dir):
        # Windows 下 npm 全局命令是 .cmd shim，subprocess 不解析 PATH 中的扩展名，需 shutil.which 解析完整路径
        cli_path = shutil.which(self.cli) or self.cli
        cmd = [cli_path, 'pages', 'deploy', src_dir, '-n', self.project_name]
        if self.api_token:
            cmd += ['-t', self.api_token]
        cmd += ['-e', 'production']
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=self.deploy_timeout,
                encoding='utf-8', errors='replace',
            )
        except FileNotFoundError:
            raise RuntimeError(
                f'EdgeOne CLI 不可用（{self.cli}）。运行环境需安装 node 并执行 npm i -g edgeone（版本≥1.2.30）')
        except subprocess.TimeoutExpired:
            raise RuntimeError(f'EdgeOne CLI 部署超时（>{self.deploy_timeout}s）')
        tail = ((proc.stdout or '') + (proc.stderr or '')).strip()[-500:]
        if proc.returncode != 0:
            raise RuntimeError(f'EdgeOne CLI 部署失败 (exit {proc.returncode}): {tail}')
        return tail

    def commit(self, message='auto update', skip_unchanged_download=False):
        files = {}
        if self.include_frontend:
            files.update(_collect_frontend_files(self.frontend_dir, self.frontend_source))
        for rel_path, content in self._buffer.items():
            files[rel_path] = content
        self._inject_routes(files)
        # edgeone.json（缓存策略）已是 pages-dist 实体文件，随前端收集自动带上

        # 兜底补全（与 CloudflareStorage 同语义 + announce）：EdgeOne 为直传整站替换制、
        # 无 CF 的 manifest 缓存继承，未写入的路径即线上删除——
        # 需自行补全全部应保留的键：活跃省 snapshot/changelog + 各已配置运营商 announce + stats；
        # 已禁用运营商/未启用省份不写入 → 线上删除（对齐 CF 语义）
        filled = 0
        for carrier_key in self.all_carrier_keys:
            if carrier_key not in self.all_active_provinces:
                continue
            ann_rel = f'{self.path_prefix}/{carrier_key}/announce.json'
            if ann_rel not in files:
                try:
                    old_ann = self.read_json(f'{carrier_key}/announce.json')
                except Exception as e:
                    logger.warning(f'EdgeOne: 补全旧公告失败 ({carrier_key}): {e}')
                    old_ann = None
                if old_ann is not None:
                    files[ann_rel] = json.dumps(old_ann, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                    filled += 1
            # 社区内容静态化兜底（acts/chats，同 announce 语义）：轻量轮 buffer 无烘焙数据，
            # 整站替换制下缺它 = 线上文件被删 → 前端回落 Worker API 前多一次 404
            # ▸ 目录名 = 资费口径（2026-10 口径统一后与 bake_community_data 产出的文件名一致）
            hub_key = carrier_key
            for bake_key in (f'{hub_key}/acts.json', f'{hub_key}/chats.json'):
                bake_rel = f'{self.path_prefix}/{bake_key}'
                if bake_rel not in files:
                    try:
                        old_bake = self.read_json(bake_key)
                    except Exception as e:
                        logger.warning(f'EdgeOne: 补全旧社区数据失败 ({bake_key}): {e}')
                        old_bake = None
                    if old_bake is not None:
                        files[bake_rel] = json.dumps(old_bake, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                        filled += 1
            for prov in PROVINCES:
                if prov['code'] not in self._get_active_province_codes(carrier_key):
                    continue
                for key in (f'{carrier_key}/snapshots/snapshot_{prov["code"]}.json',
                            f'{carrier_key}/changelogs/changelog_{prov["code"]}.json'):
                    rel = f'{self.path_prefix}/{key}'
                    if rel not in files:
                        try:
                            old_data = self.read_json(key)
                        except Exception as e:
                            logger.warning(f'EdgeOne: 补全旧数据失败 ({key}): {e}')
                            old_data = None
                        if old_data is not None:
                            files[rel] = json.dumps(old_data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                            filled += 1
        stats_rel = f'{self.path_prefix}/stats.json'
        if stats_rel not in files:
            try:
                old_stats = self.read_json('stats.json')
            except Exception as e:
                logger.warning(f'EdgeOne: 补全旧 stats 失败: {e}')
                old_stats = None
            if old_stats is not None:
                files[stats_rel] = json.dumps(old_stats, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                filled += 1

        tools_rel = f'{self.path_prefix}/tools.json'
        if tools_rel not in files:
            try:
                old_tools = self.read_json('tools.json')
            except Exception as e:
                logger.warning(f'EdgeOne: 补全旧社区工具数据失败: {e}')
                old_tools = None
            if old_tools is not None:
                files[tools_rel] = json.dumps(old_tools, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                filled += 1

        logger.info(f'EdgeOne: 准备直传 {len(files)} 个文件（基线补全 {filled}）...')
        src_dir = tempfile.mkdtemp(prefix='edgeone_deploy_')
        try:
            for rel_path, content in files.items():
                fp = os.path.join(src_dir, rel_path.replace('/', os.sep))
                os.makedirs(os.path.dirname(fp), exist_ok=True)
                with open(fp, 'wb') as f:
                    f.write(content)
            tail = self._cli_deploy(src_dir)
        finally:
            shutil.rmtree(src_dir, ignore_errors=True)
        self._buffer.clear()
        self._cleanup_local_cache()
        logger.info(f'EdgeOne: 部署成功, {len(files)} 个文件, 项目: {self.project_name}, 域名: {self.domain}')

    def list_keys(self, prefix=''):
        return []


def normalize_storage_config(config):
    """storage 配置归一化：新格式（primary + backends）与旧单 type 格式统一为
    {primary, backends(仅 enabled，primary 排首位), order}。
    同时把各线配置合并提升写回 config['storage'][name]（进程内，不落盘），
    保证 CloudflareStorage/GitHubStorage 原有读取路径不变。"""
    sc = config['storage']
    if isinstance(sc.get('backends'), dict):
        declared = sc['backends']
    else:  # 旧单 type 格式兼容
        t = sc.get('type', 'cloudflare')
        declared = {t: dict(sc.get(t) or {})}
        declared[t]['enabled'] = True
    enabled = {k: dict(v) for k, v in declared.items() if v.get('enabled')}
    if not enabled:
        raise ValueError('storage.backends 无任何 enabled 线路')
    primary = sc.get('primary') or next(iter(enabled))
    if primary not in enabled:
        raise ValueError(f'storage.primary={primary} 不在已启用线路 {list(enabled)} 中')
    order = [primary] + [k for k in enabled if k != primary]
    for name, bcfg in declared.items():
        merged = dict(sc.get(name) or {})
        merged.update(bcfg)
        merged['enabled'] = bool(bcfg.get('enabled', name in enabled))
        sc[name] = merged
    return {'primary': primary, 'backends': {k: enabled[k] for k in order}, 'order': order}


def _create_backend(name, config):
    if name == 'cloudflare':
        return CloudflareStorage(config)
    if name == 'github':
        return GitHubStorage(config)
    if name == 'edgeone':
        return EdgeOneStorage(config)
    raise ValueError(f'不支持的存储通道: {name}, 可选: cloudflare/github/edgeone')


# 2026-10 起全站运营商标识统一为资费口径（cmcc/cucc/ctcc/cbn）：数据库与烘焙目录已迁移，
# 前端请求路径、投稿表单、API 校验同口径，无映射层。
def _iter_seed_keys(carrier_keys):
    """新线种子同步键集合（已知键全量；_diag.json 等诊断文件不搬运）"""
    yield 'stats.json'
    yield 'public-config.json'
    for ck in carrier_keys:
        yield f'{ck}/announce.json'
        for prov in PROVINCES:
            yield f'{ck}/snapshots/snapshot_{prov["code"]}.json'
            yield f'{ck}/changelogs/changelog_{prov["code"]}.json'


class MultiStorage:
    """多通道存储编排：对外接口与 StorageBackend 一致，主流程零改动。
    - 读写基线走 primary 线（read_json/write_json/local_cache 全在 primary）
    - commit 遍历全部 enabled 线逐个推送（merge primary buffer → 各线 commit），单线失败仅告警
    - 新线（线上无 stats.json）首次 commit 前自动从 primary 种子同步，保证历史连续
    - commit 前为各线写入 __ROUTES__ 线路清单（前端容灾跳转数据源）"""

    def __init__(self, config, norm=None):
        self.norm = norm or normalize_storage_config(config)
        self.primary_name = self.norm['primary']
        self.pushers = {name: _create_backend(name, config) for name in self.norm['order']}
        self.primary = self.pushers[self.primary_name]
        self.route_manifest = {
            'primary': self.primary.domain,
            'fallbacks': [self.pushers[k].domain for k in self.norm['order'] if k != self.primary_name],
        }
        for p in self.pushers.values():
            p.route_manifest = self.route_manifest
        self._seeded = set()
        logger.info(f'多通道存储: primary={self.primary_name}, 线路={list(self.pushers)}, '
                    f'routes={json.dumps(self.route_manifest, ensure_ascii=False)}')

    # ── 接口代理（基线走 primary；运营商/省份状态同步到全部线——各线 commit 的兜底补全依赖）──
    def set_carrier_key(self, carrier_key):
        for p in self.pushers.values():
            p.set_carrier_key(carrier_key)

    def set_all_carrier_keys(self, keys):
        for p in self.pushers.values():
            p.set_all_carrier_keys(keys)

    def set_active_provinces(self, carrier_key, province_codes):
        for p in self.pushers.values():
            p.set_active_provinces(carrier_key, province_codes)

    @property
    def all_active_provinces(self):
        # 读代理：set_active_provinces 已把名册同步到全部线，读 primary 即全量状态；
        # 省内并发/多运营商编排合并回主存储时按此读取（与 StorageBackend 同名属性对齐）
        return self.primary.all_active_provinces

    def read_json(self, key):
        return self.primary.read_json(key)

    def write_json(self, key, data):
        self.primary.write_json(key, data)

    def write_bytes(self, key, data):
        self.primary.write_bytes(key, data)

    def list_keys(self, prefix=''):
        return self.primary.list_keys(prefix)

    def merge_buffer(self, other):
        src = other.primary if isinstance(other, MultiStorage) else other
        self.primary.merge_buffer(src)

    # ── 种子同步：新线首次部署前从 primary 全量搬运已知键 ──
    def _seed_if_new(self, name, pusher):
        if name in self._seeded:
            return
        marker = os.path.join(self.primary._local_cache_dir, f'seed_done_{name}.flag')
        if os.path.isfile(marker):
            self._seeded.add(name)
            return
        try:
            online = pusher.read_json('stats.json')
        except Exception:
            online = None
        if online is not None:
            self._seeded.add(name)
            return  # 线上已有数据，非新线
        logger.info(f'[{name}] 检测为新线，开始从 {self.primary_name} 种子同步...')
        count = 0
        for key in _iter_seed_keys(self.primary.all_carrier_keys):
            try:
                data = self.primary.read_json(key)
            except Exception as e:
                logger.warning(f'[{name}] 种子读取失败 ({key}): {e}')
                continue
            if data is not None:
                pusher.write_json(key, data)
                count += 1
        logger.info(f'[{name}] 种子同步完成: {count} 个文件')
        self._seeded.add(name)

    def commit(self, message='auto update', skip_unchanged_download=False):
        results = {}
        # 站点图标统一保活：无论全量/轻量轮，先把 local_cache/favicons/* 注入 buffer，
        # 防整站替换制下本轮未写入导致线上图标被删（快照进各线独立副本）
        _attach_favicons(self)
        # 本轮数据快照：每线注入独立副本。不能直接 merge primary 的活 buffer——
        # primary 线先 commit 时会清空自身 buffer，后续线将 merge 到空数据（丢本轮数据）
        snapshot = dict(self.primary._buffer)
        for name, pusher in self.pushers.items():
            try:
                self._seed_if_new(name, pusher)
                pusher._buffer.update(snapshot)
                pusher.commit(message, skip_unchanged_download)
                results[name] = True
            except Exception as e:
                results[name] = False
                logger.error(f'[{name}] 部署失败（不影响其他线）: {e}')
        # 各线 commit 内部只清各自注入的副本；primary 的活 buffer 在此统一清空，
        # 否则下轮 read_json 会优先命中过期 buffer 值
        self.primary._buffer.clear()
        failed = [k for k, ok in results.items() if not ok]
        if failed:
            logger.warning(f'本轮部署结果: 成功 {[k for k, ok in results.items() if ok]} / 失败 {failed}')
        return results


# ════════════════════════════════════════════════════════════
#  公共配置快照（data/public-config.json）
#  每轮部署前，从 Worker 公开只读接口搬运「人人一样、不怕逆向」的配置，
#  前端改读 Pages 静态 JSON（配置类请求零 Worker 消耗）；Worker 接口保留为快照缺失时的回落。
#  权威源仍是管理端 settings（D1）：变更生效链 = 管理端保存 → Worker 即时 →
#  下一轮采集搬运 → Pages 部署 → 前端（约一个采集周期）。
# ════════════════════════════════════════════════════════════
PUBLIC_CONFIG_API_BASE = 'https://api.ftac.dpdns.org'  # 与前端 shell/api.js 的 API_BASE 硬编码约定一致

# (快照键, Worker 接口, 合并方式)：about 由两个接口拼合；nav_links 按 collection 归档
_PUBLIC_CONFIG_SOURCES = [
    ('modules',      '/api/meta',                          'meta'),
    ('notices',      '/api/notices',                       'direct'),
    ('email_policy', '/api/auth/email-policy',             'direct'),
    ('schema',       '/api/cardhub/schema',                'direct'),
    ('ticket_apply_guarantor', '/api/tickets/apply-template?type=cardhub_guarantor', 'direct'),
    ('about',        '/api/about/timeline',                'timeline'),
    ('about',        '/api/about/thanks',                  'thanks'),
    ('about',        '/api/about/links',                   'links'),
    ('nav_links',    '/api/nav/links?collection=toolbox',  'nav'),
]


# ── 站点图标（favicon）自动抓取：为觅珍集库无图标的站点补图 ──
# 抓取链：首页 HTML <link rel="...icon..."> → 站点 /favicon.ico；持久副本存 local_cache/favicons/
# （青龙卷持久、容器重建不丢；置于 local_cache 根下而非 data/ 内——_cleanup_local_cache 会把
#   data/ 下不在运营商名单里的目录整删，favicons 放根下不受影响）。
# 文件名 = md5(站点url)[:12] + 扩展名：url 变更自动重抓，同名复用天然去重。
_FAV_EXTS = ('.png', '.ico', '.svg', '.jpg', '.gif', '.webp')
_FAV_CTYPE_EXT = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/svg+xml': '.svg',
    'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
}
_FAV_HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'}


def _fav_name_for(site_url):
    return hashlib.md5(site_url.strip().encode('utf-8')).hexdigest()[:12]


def _fav_ext_from(ctype, url_hint=''):
    ct = (ctype or '').split(';')[0].strip().lower()
    if ct in _FAV_CTYPE_EXT:
        return _FAV_CTYPE_EXT[ct]
    tail = (url_hint or '').split('?')[0].rsplit('.', 1)
    if len(tail) == 2 and tail[1].lower() in ('png', 'ico', 'svg', 'jpg', 'jpeg', 'gif', 'webp'):
        return '.jpg' if tail[1].lower() == 'jpeg' else '.' + tail[1].lower()
    return '.ico'


def _fetch_favicon(site_url):
    """抓取站点图标，返回 (bytes, 扩展名) 或 None。首页 HTML link icon → /favicon.ico 两级。"""
    try:
        parsed = urlparse(site_url)
        if parsed.scheme not in ('http', 'https') or not parsed.netloc:
            return None
        origin = f'{parsed.scheme}://{parsed.netloc}'
        # 1) 首页 HTML 提取 <link rel~=icon>（rel 与 href 先后顺序两种写法都覆盖）
        try:
            r = requests.get(site_url, timeout=(5, 8), headers=_FAV_HEADERS)
            if r.ok and r.content:
                head = r.text[:60000]
                href = None
                m = re.search(r'<link[^>]+rel=["\'][^"\']*icon[^"\']*["\'][^>]*>', head, re.I)
                if m:
                    hm = re.search(r'href=["\']([^"\']+)["\']', m.group(0), re.I)
                    if hm:
                        href = hm.group(1)
                if not href:
                    m2 = re.search(r'<link[^>]+href=["\']([^"\']+)["\'][^>]*rel=["\'][^"\']*icon[^"\']*["\']', head, re.I)
                    if m2:
                        href = m2.group(1)
                if href:
                    icon_url = urljoin(origin + '/', href.strip())
                    try:
                        ir = requests.get(icon_url, timeout=(5, 8), headers=_FAV_HEADERS)
                        if ir.ok and ir.content and len(ir.content) <= 200 * 1024 \
                                and 'html' not in (ir.headers.get('Content-Type') or '').lower():
                            return ir.content, _fav_ext_from(ir.headers.get('Content-Type'), icon_url)
                    except Exception:
                        pass
        except Exception:
            pass
        # 2) 回退站点根 /favicon.ico（SPA 回退返回 HTML 时按 Content-Type 拒绝）
        try:
            r2 = requests.get(origin + '/favicon.ico', timeout=(5, 8), headers=_FAV_HEADERS)
            if r2.ok and r2.content and len(r2.content) <= 200 * 1024 \
                    and 'html' not in (r2.headers.get('Content-Type') or '').lower():
                return r2.content, _fav_ext_from(r2.headers.get('Content-Type'), 'favicon.ico')
        except Exception:
            pass
    except Exception:
        pass
    return None


def _fav_local_file(fav_dir, site_url):
    """该站点 url 在 local_cache/favicons/ 下的既有文件名（含扩展名），无则 None"""
    name = _fav_name_for(site_url)
    for ext in _FAV_EXTS:
        if os.path.isfile(os.path.join(fav_dir, name + ext)):
            return name + ext
    return None


def _enrich_nav_icons(storage, data):
    """为觅珍集库（nav_links toolbox）无图标的站点补本地 favicon：
    本地已有 → 直接覆写 icon_url；没有 → 抓取下载后覆写。
    仅改写烘焙产物内存对象，管理端 nav_links 源数据不动；失败不影响烘焙主流程。"""
    try:
        st = getattr(storage, 'primary', storage)
        fav_dir = os.path.join(st._local_cache_dir, 'favicons')
        os.makedirs(fav_dir, exist_ok=True)
        items = data.get('items') if isinstance(data, dict) else None
        if not isinstance(items, list):
            return data
        fetched = 0
        for it in items:
            if not isinstance(it, dict):
                continue
            url = (it.get('url') or '').strip()
            if not url or url.startswith('/') or url.startswith('#'):
                continue   # 站内链接无外站图标
            if (it.get('icon_url') or '').strip():
                continue   # 站长已指定图标，尊重不覆盖
            existing = _fav_local_file(fav_dir, url)
            if existing is None:
                if fetched >= 20:
                    continue   # 单轮抓取上限：首轮大量缺图时自然分摊到后续轮次，防拖死采集
                got = _fetch_favicon(url)
                if got:
                    content, ext = got
                    with open(os.path.join(fav_dir, _fav_name_for(url) + ext), 'wb') as f:
                        f.write(content)
                    existing = _fav_name_for(url) + ext
                    fetched += 1
                    time.sleep(0.3)   # 温和节流，减轻对方站点压力
            if existing:
                it['icon_url'] = f'/data/favicons/{existing}'   # 根绝对路径：SPA 部署于站点根，同源加载
        if fetched:
            logger.info(f'[favicons] 本轮新抓 {fetched} 个站点图标（存 local_cache/favicons/）')
    except Exception as e:
        logger.warning(f'[favicons] 补图处理失败(不影响烘焙): {str(e)[:120]}')
    return data


def _attach_favicons(storage):
    """部署前把 local_cache/favicons/* 注入 primary buffer：
    ① 每轮部署（含轻量轮）随数据一起上传，防整站替换制下线上图标文件被删；
    ② MultiStorage.commit 会把 buffer 快照分发给全部启用线路，三通道自动携带。"""
    try:
        st = getattr(storage, 'primary', storage)
        fav_dir = os.path.join(st._local_cache_dir, 'favicons')
        if not os.path.isdir(fav_dir):
            return
        n = 0
        for fname in sorted(os.listdir(fav_dir)):
            fpath = os.path.join(fav_dir, fname)
            if not os.path.isfile(fpath):
                continue
            with open(fpath, 'rb') as f:
                st.write_bytes(f'favicons/{fname}', f.read())
            n += 1
        if n:
            logger.info(f'[favicons] 已注入 {n} 个站点图标随本轮部署')
    except Exception as e:
        logger.warning(f'[favicons] 图标注入失败(不影响部署): {str(e)[:120]}')


def refresh_public_config(storage):
    """拉取公共配置快照写入待部署 buffer；单项失败跳过（前端该项回落 Worker 接口），整体失败不阻塞部署。
    单项 4 次尝试 + 指数退避 2/4/8s（±20% 抖动）：meta 是聚合接口全家最重（实测 2.6s vs 其他 <1.5s），
    青龙出口到 CF 边缘的链路在部署时段间歇抖动，单次 15s 窗口连续两轮超时——加宽窗口并给足重试。"""
    s = requests.Session()
    cfg = {'generated_at': now_iso()}
    ok_cnt = 0
    for key, path, mode in _PUBLIC_CONFIG_SOURCES:
        j = None
        last_err = None
        disabled = False   # 模块总开关关闭（MODULE_DISABLED）：非瞬时故障，按预期跳过不重试
        for attempt in range(4):
            try:
                r = s.get(PUBLIC_CONFIG_API_BASE + path, timeout=30)
                r.raise_for_status()
                j = r.json()
                if j.get('code') != 0:   # Worker 统一信封 {code, message, data}
                    raise RuntimeError(f'envelope code={j.get("code")}')
                break
            except Exception as e:
                j = None
                last_err = e
                # Worker 对已关闭模块的 /api/cardhub/* 统一 503 {code:50300, message:"MODULE_DISABLED"}：
                # 重试无意义（模块开关不变则恒 503），识别后立即跳出，日志降为 INFO 消除每轮告警噪音
                _resp = getattr(e, 'response', None)
                if _resp is not None and _resp.status_code == 503 and 'MODULE_DISABLED' in (_resp.text or ''):
                    disabled = True
                    break
                if attempt < 3:
                    wait = min(2 ** (attempt + 1), 8) * (0.8 + 0.4 * random.random())
                    logger.warning(f'[public-config] {path} 第 {attempt + 1} 次失败: {str(e)[:80]}，{wait:.1f}s 后重试')
                    time.sleep(wait)
        if j is None:
            if disabled:
                logger.info(f'[public-config] {path} 模块已关闭(MODULE_DISABLED)，按预期跳过，前端该项回落接口')
            else:
                logger.warning(f'[public-config] {path} 搬运失败(4 次尝试仍失败，前端该项将回落接口): {str(last_err)[:100]}')
            continue
        data = j.get('data') or {}
        if mode == 'timeline':
            cfg.setdefault('about', {})['timeline'] = data.get('timeline') or []
        elif mode == 'thanks':
            cfg.setdefault('about', {})['thanks'] = data.get('groups') or {}
        elif mode == 'links':
            cfg.setdefault('about', {})['links'] = data.get('links') or []
        elif mode == 'nav':
            data = _enrich_nav_icons(storage, data)   # 无图标站点补抓 favicon 并覆写 icon_url
            cfg['nav_links'] = {'toolbox': data}   # 保留 {items:[...]} 形状，前端与接口响应同构消费
        elif mode == 'meta':
            # /api/meta 的 data 自带 {modules:{...}} 包装（包装键与快照键同名），
            # direct 直塞会双层嵌套导致前端 pc.modules.cardhub 恒 undefined、菜单入口永不隐藏——解包一层
            cfg['modules'] = data.get('modules') or {}
        else:
            cfg[key] = data
        ok_cnt += 1
    if ok_cnt == 0:
        logger.warning('[public-config] 全部接口失败，本轮不生成快照')
        return
    try:
        storage.write_json('public-config.json', cfg)
        logger.info(f'[public-config] 快照已生成（{ok_cnt}/{len(_PUBLIC_CONFIG_SOURCES)} 项）')
    except Exception as e:
        logger.warning(f'[public-config] 快照写入失败(不影响本次部署): {str(e)[:100]}')


# ════════════════════════════════════════════════════════════
#  社区内容静态化烘焙（acts/chats/tools）
# ════════════════════════════════════════════════════════════
#  情报酒馆/唠嗑聚落/工具宝库公开列表低频变更、不追求实时：从 Worker 导出端点
#  (/api/export/acts|chats|navlinks) 拉取公开数据烘焙为静态 JSON 随三线部署：
#    ▸ data/{carrier}/acts.json ：该运营商条目 + 全运营商通用（carrier=''），前端按省过滤
#    ▸ data/{carrier}/chats.json：同上（mode=chat 社群）
#    ▸ data/tools.json          ：全部集合 open 导航链接
#  投稿/待审/收藏等登录态私有数据仍走 Worker 实时接口；静态文件缺失时前端自动回落
#  Worker API（同公告模式 fetch 失败回退），数据无损。
#  轻量轮（announce-only）不烘焙：部署层兜底逻辑会继承线上旧文件防误删。


def _bake_fetch(s, path):
    """拉取导出端点（4 次尝试 + 指数退避 ±抖动，同 refresh_public_config 口径）；失败返回 None"""
    last_err = None
    for attempt in range(4):
        try:
            r = s.get(PUBLIC_CONFIG_API_BASE + path, timeout=30)
            r.raise_for_status()
            j = r.json()
            if j.get('code') != 0:   # Worker 统一信封 {code, message, data}
                raise RuntimeError(f'envelope code={j.get("code")}')
            return j.get('data') or {}
        except Exception as e:
            last_err = e
            if attempt < 3:
                wait = min(2 ** (attempt + 1), 8) * (0.8 + 0.4 * random.random())
                logger.warning(f'[bake] {path} 第 {attempt + 1} 次失败: {str(e)[:80]}，{wait:.1f}s 后重试')
                time.sleep(wait)
    logger.warning(f'[bake] {path} 拉取失败(4 次尝试仍失败，前端将回落 Worker 接口): {str(last_err)[:100]}')
    return None


def bake_community_data(storage, config, carrier_keys=None):
    """社区内容静态化：拉取导出端点写 acts/chats/tools 快照进部署 buffer。
    逐项尽力而为：任一端点/文件失败只跳过该项，不阻塞部署。
    ▸ 目录名/过滤用资费口径（cmcc/cucc/ctcc/cbn）——2026-10 口径统一后 activities/communities
      体系（API 校验、前端提交表单、前端请求路径）全部同口径，无映射层"""
    if carrier_keys is None:
        carrier_keys = [k for k, v in (config.get('carriers') or {}).items() if v.get('enabled', True)]
    s = requests.Session()
    acts = _bake_fetch(s, '/api/export/acts')
    chats = _bake_fetch(s, '/api/export/chats')
    tools = _bake_fetch(s, '/api/export/navlinks')

    if tools is not None:
        try:
            # tools.json 是觅珍集库前端第一优先数据源（public-config nav_links 仅回退），
            # 无图标站点的 favicon 补抓在此处接入，保证主源与回退源的 icon_url 一致
            tools_data = _enrich_nav_icons(storage, {'generated_at': now_iso(), 'items': tools.get('items') or []})
            storage.write_json('tools.json', tools_data)
        except Exception as e:
            logger.warning(f'[bake] tools.json 写入失败(不影响本次部署): {str(e)[:100]}')

    act_items = (acts or {}).get('items') or []
    chat_items = (chats or {}).get('items') or []
    gen = now_iso()
    for ck in carrier_keys:
        # 口径统一后 hub = ck（无映射）
        hub = ck
        # 只保留该运营商条目 + 全运营商/全站通用条目（carrier=''），与 API 视图同构，前端再按省过滤
        sub_acts = [x for x in act_items if x.get('carrier') == hub or not x.get('carrier')]
        sub_chats = [x for x in chat_items if x.get('carrier') == hub or not x.get('carrier')]
        try:
            storage.write_json(f'{hub}/acts.json', {'generated_at': gen, 'items': sub_acts})
        except Exception as e:
            logger.warning(f'[bake] {hub}/acts.json 写入失败(不影响本次部署): {str(e)[:100]}')
        try:
            storage.write_json(f'{hub}/chats.json', {'generated_at': gen, 'items': sub_chats})
        except Exception as e:
            logger.warning(f'[bake] {hub}/chats.json 写入失败(不影响本次部署): {str(e)[:100]}')
    logger.info(f'[bake] 社区内容烘焙完成: acts={len(act_items)} chats={len(chat_items)} tools={len((tools or {}).get("items") or [])}')


def create_storage(config):
    """多通道工厂：返回 MultiStorage 编排（单 enabled 线时行为与原单后端完全一致）。
    兼容旧单 type 配置（normalize_storage_config 自动归一化）。"""
    norm = normalize_storage_config(config)
    return MultiStorage(config, norm)


# ════════════════════════════════════════════════════════════
#  通知模块: 通过青龙面板内置通知渠道发送
# ════════════════════════════════════════════════════════════

def should_notify(ntype, config):
    nt = config.get('notification', {}).get('types', {})
    type_map = {
        'change': 'change',
        'error': 'error',
        'degrade': 'degrade',
        'all_fail': 'all_fail',
        'no_change': 'no_change',
    }
    key = type_map.get(ntype)
    if key and not nt.get(key, True):
        logger.debug(f'通知类型 [{ntype}] 已关闭，跳过发送')
        return False
    return True


def send_notification(title, content, config=None):
    try:
        # 通知渠道开关（配置页「通知渠道」组）：ql_panel=false = 不走青龙推送，仅记日志（内容不丢）
        # 未传 config 时保持原有行为（如 __main__ 致命错误兜底：config 可能尚未加载，致命通知始终尝试推送）
        if config is not None and not config.get('notification', {}).get('channels', {}).get('ql_panel', True):
            logger.info('通知渠道「青龙面板通知」已关闭（notification.channels.ql_panel=false），跳过推送')
            logger.info('=' * 60)
            logger.info('执行结果通知（未推送，仅记录）:')
            logger.info('-' * 60)
            for line in content.split('\n'):
                logger.info(line)
            logger.info('=' * 60)
            return
        try:
            from qlapi import notify
            notify(title, content)
            logger.info('通知已发送（青龙面板 notify）')
            return
        except ImportError:
            pass

        try:
            import subprocess
            import json
            import tempfile
            import os
            js_content = (
                'const{sendNotify}=require("./sendNotify");'
                f'sendNotify({json.dumps(title)},{json.dumps(content)})'
            )
            tmp_fd, tmp_path = tempfile.mkstemp(suffix='.js', prefix='notify_')
            try:
                with os.fdopen(tmp_fd, 'w', encoding='utf-8') as f:
                    f.write(js_content)
                result = subprocess.run(
                    ['node', tmp_path],
                    capture_output=True, text=True, timeout=30
                )
                if result.returncode == 0:
                    logger.info('通知已发送（青龙 sendNotify）')
                    return
            finally:
                os.remove(tmp_path)
        except Exception:
            pass

        logger.info('=' * 60)
        logger.info('执行结果通知:')
        logger.info('-' * 60)
        for line in content.split('\n'):
            logger.info(line)
        logger.info('=' * 60)
        logger.info('提示: 如需推送通知，请在青龙面板配置通知渠道')

    except Exception as e:
        logger.warning(f'发送通知失败: {e}')


def build_change_summary(carrier_key, crawl_results, carrier_cfg):
    notify_provs = carrier_cfg.get('notification', {}).get('provinces', [])
    _name_to_code = {p['name']: p['code'] for p in PROVINCES}
    carrier_label = CARRIER_DISPLAY_NAMES.get(carrier_key, carrier_key)
    lines = [f'【{carrier_label}资费变更监控】', '']

    total_added = 0
    total_removed = 0
    total_changed = 0
    changed_provinces = []

    for prov_name, result in crawl_results.items():
        if not result or not result.get('changes'):
            continue
        prov_short = _name_to_code.get(prov_name, '')
        if notify_provs and prov_short and prov_short not in notify_provs:
            continue
        changes = result['changes']
        added = len(changes.get('added', []))
        removed = len(changes.get('removed', []))
        changed = len(changes.get('modified', []))

        if added == 0 and removed == 0 and changed == 0:
            continue

        total_added += added
        total_removed += removed
        total_changed += changed
        changed_provinces.append(prov_name)

        lines.append(f'══ {prov_name} ══')
        if added:
            lines.append(f'  新增 {added} 条')
        if removed:
            lines.append(f'  下架 {removed} 条')
        if changed:
            lines.append(f'  修改 {changed} 条')
        lines.append('')

    if not changed_provinces:
        return None

    header = f'共 {len(changed_provinces)} 省有变更: 新增{total_added} / 下架{total_removed} / 修改{total_changed}'
    return f'{header}\n\n' + '\n'.join(lines)


# ───────────────────────── 采集播报（ext_msg 通道，方案批次一） ─────────────────────────
# 全量整理本轮变更 → digest 文件落盘 → 子进程叫醒 notify_dispatch.py。
# 与 ql_panel 通知并行独立：ql_panel 摘要按站长关注省整理时过滤，本通道全量落盘、
# 省份过滤在分发端按订阅用户执行。ext_msg 关闭时整段跳过（无文件、无调用）。


def resolve_digest_dir(config):
    """采集播报统一工作目录：notification.digest_dir 优先（自动创建），
    空/不可用回退脚本自身所在目录——永不依赖 cwd（updater 下载执行，运行目录不保证是 scripts 目录）"""
    base = os.path.dirname(os.path.abspath(__file__))
    raw = config.get('notification', {}).get('digest_dir', '')
    if isinstance(raw, str) and raw.strip():
        d = os.path.abspath(os.path.expanduser(raw.strip()))
        try:
            os.makedirs(d, exist_ok=True)
            return d
        except Exception as e:
            logger.warning(f'[digest] 配置目录不可用({d}): {e}，回退脚本所在目录')
    return base


def _digest_counts(crawl_results):
    """crawl_results → {省code: {name, added, changed, removed}}（仅含有变化的省，全量不过滤）"""
    name_to_code = {p['name']: p['code'] for p in PROVINCES}
    out = {}
    for prov_name, result in (crawl_results or {}).items():
        if not result or not result.get('changes'):
            continue
        changes = result['changes']
        added = len(changes.get('added', []))
        removed = len(changes.get('removed', []))
        changed = len(changes.get('modified', []))
        if added == 0 and removed == 0 and changed == 0:
            continue
        code = name_to_code.get(prov_name, '')
        out[code or prov_name] = {'name': prov_name, 'added': added, 'changed': changed, 'removed': removed}
    return out


def _merge_digest_counts(base, add):
    """把本轮计数并入累计结构（base 被就地修改并返回）"""
    for code, c in (add or {}).items():
        cur = base.get(code)
        if not isinstance(cur, dict):
            base[code] = dict(c)
        else:
            cur['added'] += c['added']
            cur['changed'] += c['changed']
            cur['removed'] += c['removed']
    return base


def _write_digest_json(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, path)


def write_collector_digest(config, all_crawl_results, announce_new=None):
    """每轮采集结束后调用：写本轮 digest（含当日累计与公告新增）→ 叫醒分发脚本。
    资费无变更且公告无新增 → 不写文件不叫醒（免打扰，已确认口径）；
    任何异常仅告警，不影响采集主流程。"""
    try:
        if not config.get('notification', {}).get('channels', {}).get('ext_msg', False):
            return
        if not isinstance(announce_new, dict):
            announce_new = {}
        d = resolve_digest_dir(config)
        now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
        date_str = now.strftime('%Y%m%d')

        round_counts = {}
        for carrier_key, crawl_results in (all_crawl_results or {}).items():
            counts = _digest_counts(crawl_results)
            if counts:
                round_counts[carrier_key] = counts
        if not round_counts and not announce_new:
            logger.info('[digest] 本轮无变更（资费/公告均无），不生成采集播报文件')
            return

        # 当日累计：读旧状态合并（日期翻篇自动重置；旧文件损坏按无累计处理）
        today_counts = {}
        try:
            with open(os.path.join(d, 'coll_today.json'), encoding='utf-8') as f:
                prev = json.load(f)
            if prev.get('date') == date_str and isinstance(prev.get('carriers'), dict):
                today_counts = prev['carriers']
        except Exception:
            pass
        for carrier_key, counts in round_counts.items():
            _merge_digest_counts(today_counts.setdefault(carrier_key, {}), counts)
        _write_digest_json(os.path.join(d, 'coll_today.json'),
                           {'date': date_str, 'carriers': today_counts})

        digest = {
            'date': date_str,
            'round_at': int(now.timestamp() * 1000),
            'round': round_counts,
            'today': today_counts,
            'announce': announce_new,
        }
        digest_path = os.path.join(d, 'coll_digest_%s_%s.json' % (date_str, now.strftime('%H%M%S')))
        _write_digest_json(digest_path, digest)
        logger.info(f'[digest] 采集播报已落盘: {os.path.basename(digest_path)}'
                    f'（资费变更 {len(round_counts)} 运营商 / 公告新增 {len(announce_new)} 运营商，目录: {d}）')

        # 叫醒分发脚本（文件即队列；flock 防重入，撞锁/失败退出码均忽略，文件留给下轮补扫）
        dispatch = os.path.join(d, 'notify_dispatch.py')
        if os.path.isfile(dispatch):
            try:
                r = subprocess.run([sys.executable, dispatch], cwd=d, timeout=1800,
                                   capture_output=True, text=True)
                tail = (r.stdout or '').strip().splitlines()
                logger.info(f'[digest] 分发脚本已执行（exit={r.returncode}）: {tail[-1] if tail else "(无输出)"}')
            except Exception as e:
                logger.warning(f'[digest] 叫醒分发失败(文件留存下轮补扫): {e}')
        else:
            logger.info(f'[digest] 分发脚本不存在({dispatch})，跳过叫醒')
    except Exception as e:
        logger.warning(f'[digest] 采集播报整理失败(已忽略，不影响采集): {e}')


def build_nochange_message():
    beijing = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    ts = beijing.strftime('%Y-%m-%d %H:%M:%S')
    return f'【资费变更监控】\n\n本次未检测到资费变化。\n\n检测时间：{ts}'


def build_error_message(errors):
    return f'【资费监控 · 异常提醒】\n\n{errors}\n\n本次已跳过对比，历史快照未受影响。'


# ════════════════════════════════════════════════════════════
#  主流程: 采集、对比、存储、通知
# ════════════════════════════════════════════════════════════

def crawl_province(api, prov, config, carrier_key='cmcc'):
    prov_code = prov['code']
    prov_name = prov['name']
    prov_short = prov['code']

    crawl_cfg = config['crawl']
    category_mode = crawl_cfg['category_mode']
    fixed_categories = crawl_cfg.get('fixed_categories', [])
    pagination_mode = crawl_cfg.get('pagination_mode', 'auto')
    max_pages = crawl_cfg['max_pages']
    page_size = crawl_cfg['page_size']
    retry_times = crawl_cfg['retry_times']
    retry_base_ms = crawl_cfg['retry_base_ms']
    retry_max_ms = crawl_cfg['retry_max_ms']
    retry_jitter = crawl_cfg.get('retry_jitter', 0.3)
    category_interval_ms = crawl_cfg.get('category_interval_ms', 2000)
    page_interval_ms = crawl_cfg.get('page_interval_ms', 300)

    categories = api.resolve_categories(
        prov_code, category_mode, fixed_categories,
        retry_times=retry_times,
        retry_base_ms=retry_base_ms,
        retry_max_ms=retry_max_ms,
        retry_jitter=retry_jitter,
        page_interval_ms=page_interval_ms,
    )

    all_items = []
    seen_ids = set()
    failed_categories = []
    failed_cat_keys = []   # 失败分类的结构化键 (attr,t1,t2)：供 partial 省沿用旧快照条目
    province_diag = {'name': prov_name, 'code': prov_short, 'categories': []}

    # 设计决策：分类遍历不采用 ThreadPoolExecutor 并发，原因：
    #   1. 已有省份级并发（province_workers），不同省份请求天然分散到不同省份接口，风控信号弱；
    #      分类并发则同省多分类同时请求同一 API 端点，风控信号强，易触发限流。
    #   2. 省份并发×分类并发 的叠加峰值 = province_workers × category_workers，
    #      如 3×3=9 并发请求到移动同一接口，风控风险极高。
    #   3. 分类间隔等待占单省耗时 72%，缩短 category_interval_ms（如 8s→2-3s）
    #      可获得等价 70-80% 的加速效果，零代码改动。
    #   4. 嵌套线程池（省份线程内再起分类线程）增加调试/异常处理复杂度，投入产出比不高。
    # 如确需进一步加速，优先缩短 category_interval_ms；极端场景再考虑分类并发，
    # 但必须引入 province_workers × category_workers 总上限硬约束。
    for ti, cat in enumerate(categories):
        attr = cat['tariffAttr']
        t1 = cat['type1']
        t2 = cat['type2']
        cm = config.get('category_maps', {}) or {}
        attr_label = (cm.get('attr') or {}).get(attr, attr)
        cucc_first_name = cat.get('_cucc_first_name', '')
        cucc_second_name = cat.get('_cucc_second_name', '')
        if cucc_first_name and cucc_second_name:
            cat_desc = f'{attr_label}/{cucc_first_name}/{cucc_second_name}'
        else:
            t1_label = (cm.get('t1') or {}).get(t1, t1)
            t2_label = (cm.get('t2') or {}).get(t2, t2)
            cat_desc = f'{attr_label}/{t1_label}/{t2_label}'

        logger.info(f'  [{ti + 1}/{len(categories)}] 采集分类: {cat_desc}')

        cat_items = []
        cat_ids = set()      # 本分类已计数的条目 id：跨重试轮累计，保证日志计数与实际入库一致
        cat_failed = False
        cat_fail_reason = None
        cat_total_start = time.time()   # 分类总耗时起点（含重试轮与退避等待，不随重试复位）
        pages_fetched = 0
        total_retries = 0
        request_failures = 0
        prev_page_signature = None
        pagination_confirmed = None
        # 分页模式说明（代码可能随功能变化而调整，注释仅供参考）：
        #   - bulk: 只请求第1页，完全信任API一次返回全部数据，不翻页不对比。适用于已确认不分页的API。
        #   - page: 固定请求 max_pages 页，适用于已确认支持分页且数据量大的API。
        #   - auto: 智能翻页，通过内容对比自动判断是否还有下一页，适用于不确定API是否支持分页的场景。
        if pagination_mode == 'bulk':
            pages_to_try = [1]
        else:
            pages_to_try = range(1, max_pages + 1)
        # 分类级重试：请求级重试(retry_times 次)耗尽仍失败时，整分类指数退避后重跑。
        # 参数复用 crawl.retry_* 配置（与请求级同源，指数退避+封顶+抖动）；
        # 已抓页的条目经 seen_ids 去重，重跑不重复入库；失败常见形态为瞬时限流/抖动，隔几十秒重试几乎必成
        cat_attempt = 0
        while True:
            for page in pages_to_try:
                try:
                    extra_cat_params = {k: v for k, v in cat.items() if k.startswith('_')}
                    result = api.get_tariff_list(
                        prov_code, attr, t1, t2,
                        page=page, limit=page_size,
                        retry_times=retry_times,
                        retry_base_ms=retry_base_ms,
                        retry_max_ms=retry_max_ms,
                        retry_jitter=retry_jitter,
                        **extra_cat_params,
                    )
                except Exception as e:
                    cat_failed = True
                    cat_fail_reason = str(e)[:100]
                    request_failures += 1
                    total_retries += getattr(api, '_last_retry_count', 0)
                    logger.warning(f'  分类 {cat_desc} 第{page}页请求失败: {e}')
                    break

                total_retries += getattr(api, '_last_retry_count', 0)

                if not result or not result.get('data'):
                    if page == 1:
                        cat_failed = True
                        cat_fail_reason = '第1页无数据'
                    break

                beans = result['data'].get('beans') or []
                if not beans:
                    break

                pages_fetched = max(pages_fetched, page)

                for bean in beans:
                    items = standardize_bean(bean, prov_short, prov_name, attr, t1, t2, cmcc_code=prov_code, carrier=carrier_key)
                    for item in items:
                        if item['id'] not in seen_ids:
                            seen_ids.add(item['id'])
                            all_items.append(item)
                        if item['id'] not in cat_ids:
                            cat_ids.add(item['id'])
                            cat_items.append(item)

                if pagination_mode == 'auto':
                    n = len(beans)
                    if n < page_size:
                        break
                    if n > page_size:
                        break
                    cur_sig = hashlib.md5(json.dumps(beans, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()
                    if pagination_confirmed is None:
                        prev_page_signature = cur_sig
                    else:
                        if cur_sig == prev_page_signature:
                            break
                        pagination_confirmed = True
                        prev_page_signature = cur_sig

                if pagination_mode != 'bulk' and page < max_pages:
                    jitter_offset = page_interval_ms / 1000 * 0.2 * (2 * random.random() - 1)
                    wait = max(0.05, page_interval_ms / 1000 + jitter_offset)
                    time.sleep(wait)

            if not cat_failed:
                break
            # 请求级重试耗尽仍失败 → 分类级指数退避后整类重跑（“第1页无数据”同待遇）
            cat_attempt += 1
            if cat_attempt > retry_times:
                break
            backoff = min(retry_base_ms * (2 ** (cat_attempt - 1)), retry_max_ms) / 1000
            backoff = max(0.1, backoff * (1 + retry_jitter * (2 * random.random() - 1)))
            logger.warning(f'  分类 {cat_desc} 请求级重试耗尽，{backoff:.1f}s 后整类重试（第{cat_attempt}/{retry_times}轮）: {cat_fail_reason}')
            time.sleep(backoff)
            cat_items = []
            cat_failed = False
            cat_fail_reason = None
            prev_page_signature = None
            pagination_confirmed = None

        cat_cost_ms = int((time.time() - cat_total_start) * 1000)
        meta = f'耗时{cat_cost_ms / 1000:.2f}s'
        if pages_fetched:
            meta += f' · 翻页{pages_fetched}次'
        if total_retries:
            meta += f' · 重试{total_retries}次'
        if request_failures:
            meta += f' · 失败{request_failures}次'

        if cat_failed:
            failed_categories.append(cat_desc)
            failed_cat_keys.append({'attr': attr, 't1': t1, 't2': t2})
            logger.warning(f'  分类 {cat_desc} 采集失败 ({meta})')
        elif cat_items:
            logger.info(f'  分类 {cat_desc}: {len(cat_items)} 个套餐 ({meta})')
        else:
            logger.info(f'  分类 {cat_desc}: 无数据 ({meta})')

        province_diag['categories'].append({
            'attr': attr,
            't1': t1,
            't2': t2,
            'pages': pages_fetched,
            'items': len(cat_items),
            'retries': total_retries,
            'ms': cat_cost_ms,
            'status': 'fail' if cat_failed else 'ok',
            'reason': cat_fail_reason,
        })

        if ti < len(categories) - 1:
            jitter_offset = category_interval_ms / 1000 * 0.2 * (2 * random.random() - 1)
            wait = max(0.1, category_interval_ms / 1000 + jitter_offset)
            time.sleep(wait)

    status = 'success' if not failed_categories else ('partial' if all_items else 'failed')
    if failed_categories:
        logger.warning(f'  {len(failed_categories)} 个分类采集失败: {", ".join(failed_categories)}')

    return {
        'province': prov_name,
        'code': prov_short,
        'items': all_items,
        'total': len(all_items),
        'status': status,
        'failed_categories': failed_categories,
        'failed_cat_keys': failed_cat_keys,
        'content_duplicate_ratio': compute_content_duplicate_ratio(all_items),
        'diag': province_diag,
    }


def compute_content_duplicate_ratio(items):
    if not items:
        return 0.0
    signatures = set()
    for it in items:
        fields = it.get('fields') or {}
        sig = '|'.join([
            str(it.get('name', '')),
            str(it.get('tariff_attr', '')),
            str(it.get('type1', '')),
            str(it.get('type2', '')),
            str(fields.get('资费标准', '')),
            str(fields.get('产品价格', '')),
        ])
        signatures.add(hashlib.md5(sig.encode('utf-8')).hexdigest())
    return 1 - len(signatures) / len(items)


# 设计决策：不引入分类级降级自检（hunan 的 _evaluate_degrade + peaks.json），原因：
#   现有机制（重试 + 波动检测 + partial 通知）已形成完整防御链，降级自检在该链上无增量动作：
#   1. 多分类限流降级：重试排除临时故障，波动检测 hard_reject 保留旧数据，
#      降级自检检测后动作相同——保留旧数据，零增量。
#   2. 真实业务骤降（降级自检唯一增量场景）：可释放 hard_reject 让变更正常通知，
#      但运营商单轮骤降 50%+ 极罕见，且自动放行骤降更新本身有风险，
#      hard_reject 的保守策略（人工确认后再覆盖）反而更安全。
#   3. 分类间此消彼长：波动检测已正确处理（总量变化不大 → normal），零增量。
#   4. 单分类限流：partial 通知已覆盖，零增量。
def check_volatility(old_count, new_count, carrier_cfg):
    vol = carrier_cfg['volatility']
    if old_count == 0:
        return {'level': 'normal', 'ratio': 0, 'threshold': vol['threshold']}
    diff = new_count - old_count
    ratio = abs(diff) / old_count
    direction = 'decrease' if diff < 0 else 'increase'
    if ratio >= vol['threshold_sudden']:
        return {'level': 'hard_reject', 'ratio': ratio, 'threshold': vol['threshold_sudden'], 'direction': direction}
    if ratio >= vol['threshold']:
        return {'level': 'soft_warn', 'ratio': ratio, 'threshold': vol['threshold'], 'direction': direction}
    return {'level': 'normal', 'ratio': ratio, 'threshold': vol['threshold']}


def _build_and_save_stats(config, storage, all_crawl_results, crawl_time, crawl_duration_ms, all_success_count, all_fail_count, old_stats=None):
    interval_hours = config['schedule']['interval_hours']
    next_crawl_time = compute_next_crawl_time(interval_hours)

    if old_stats is None:
        old_stats = storage.read_json('stats.json')

    total_success = sum(all_success_count.values())
    total_fail = sum(all_fail_count.values())

    if total_fail == 0:
        status = 'success'
    elif total_success > 0:
        status = 'partial_failure'
    else:
        status = 'total_failure'

    carriers_data = {}

    for carrier_key, crawl_results in all_crawl_results.items():
        carrier_cfg = get_carrier_config(config, carrier_key)
        default_province = carrier_cfg['default_province']
        target_provinces = get_target_provinces(carrier_cfg, carrier_key)

        province_data = []
        carrier_dedup_keys = set()   # 跨省去重键集合（全网+31省，供「全网资费总量(去重)」统计）
        for prov in target_provinces:
            result = crawl_results.get(prov['name'])
            digested = (result or {}).get('_digested')
            if digested:
                # 省份级流水线：省级摘要已在采集期生成（原始条目已释放），直接组装；
                # 去重键 = 各包子集的并集（结合律保证与全量合并等价）
                province_data.append(digested['province_data'])
                carrier_dedup_keys.update(digested['dedup_keys'])
                continue
            if result and result.get('items') is not None:
                items = result['items']
                for it in items:
                    n = (it.get('name') or '').strip()
                    if not n:
                        continue
                    # 去重键 = 方案编号：全国方案跨省同码只计一次；同名不同码（价格不同）是不同方案不合并；无编号回退名称
                    code = ((it.get('fields') or {}).get('方案编号') or '').strip()
                    carrier_dedup_keys.add('c:' + code if code else 'n:' + n)
                changes = result.get('changes', {})
                crawl_status = result.get('crawl_status', 'success')
                data_crawl_time = result.get('data_crawl_time', crawl_time)

                dist = compute_dist(items)
                breakdown = compute_breakdown(items)

                last_crawl = {}
                for change_type, key in (('added', 'added'), ('removed', 'removed'), ('modified', 'changed')):
                    for c in changes.get(change_type, []):
                        attr = c.get('attr', '') or '0'
                        last_crawl.setdefault(attr, {'added': 0, 'removed': 0, 'changed': 0})
                        last_crawl[attr][key] += 1

                from datetime import datetime as _dt, timedelta as _td
                # 「今日」窗口锚定北京时间 0 点（ts 全链路 UTC 存储：+8h 转北京时间取 0 点，再 -8h 换回 UTC 比较）
                _bj = _dt.strptime(crawl_time, '%Y-%m-%dT%H:%M:%S.%fZ') + _td(hours=8)
                today_start = _bj.replace(hour=0, minute=0, second=0, microsecond=0) - _td(hours=8)
                today_start_iso = today_start.strftime('%Y-%m-%dT%H:%M:%S.000Z')
                changelog_path = f'{carrier_key}/changelogs/changelog_{prov["code"]}.json'
                changelog_data = storage.read_json(changelog_path) or {}
                today_entries = [e for e in (changelog_data.get('logs') or [])
                                 if (e.get('ts') or '') >= today_start_iso]

                today = {}
                for c in today_entries:
                    attr = c.get('attr', '') or '0'
                    ctype = c.get('type')
                    if ctype in ('added', 'removed', 'changed'):
                        today.setdefault(attr, {'added': 0, 'removed': 0, 'changed': 0})
                        today[attr][ctype] += 1

                province_data.append({
                    'code': prov['code'],
                    'name': prov['name'],
                    'breakdown': breakdown,
                    'data_crawl_time': data_crawl_time,
                    'crawl_status': crawl_status,
                    'last_crawl': last_crawl,
                    'today': today,
                    'dist': dist,
                    'volatility': result.get('volatility'),
                    'consecutive_degrade_count': result.get('consecutive_degrade_count', 0),
                })
            else:
                old_prov = {}
                if old_stats:
                    old_provinces = ((old_stats.get('carriers') or {}).get(carrier_key) or {}).get('provinces') or old_stats.get('provinces') or []
                    for p in old_provinces:
                        if p.get('code') == prov['code']:
                            old_prov = p
                            break

                province_data.append({
                    'code': prov['code'],
                    'name': prov['name'],
                    'breakdown': old_prov.get('breakdown', {}),
                    'data_crawl_time': old_prov.get('data_crawl_time', ''),
                    'crawl_status': result.get('crawl_status', 'failed') if result else 'failed',
                    'last_crawl': old_prov.get('last_crawl', {}),
                    'today': old_prov.get('today', {}),
                    'dist': old_prov.get('dist', {}),
                    'volatility': None,
                    'consecutive_degrade_count': old_prov.get('consecutive_degrade_count', 0),
                })

        carriers_data[carrier_key] = {
            'default_province': default_province,
            'province_data': province_data,
            'name_set': carrier_dedup_keys,   # 内存传递，不落盘（stats 只写入去重计数）
        }

    cache_ttl = config.get('storage', {}).get('cache', {}).get('ttl_minutes', 30)
    default_carrier = config.get('default_carrier', 'cmcc')
    stats = build_stats({
        'crawl_time': crawl_time,
        'next_crawl_time': next_crawl_time,
        'status': status,
        'last_crawl_duration_ms': crawl_duration_ms,
        'carriers': carriers_data,
        'cache_ttl_minutes': cache_ttl,
        'default_carrier': default_carrier,
    })

    storage.write_json('stats.json', stats)
    logger.info(f'stats.json 已保存 (status={status})')


def _malloc_trim_now():
    """主动归还 glibc 空闲页（碎片整理，malloc_trim 线程安全）。
    返回释放的 kB；非 Linux / 无法读取时返回 None。"""
    before = None
    try:
        with open('/proc/self/status', encoding='utf-8') as f:
            for line in f:
                if line.startswith('VmRSS:'):
                    before = int(line.split()[1])
                    break
        if before is None:
            return None
        import ctypes as _ct
        _libc = _ct.CDLL('libc.so.6')
        _libc.malloc_trim(0)
        with open('/proc/self/status', encoding='utf-8') as f:
            for line in f:
                if line.startswith('VmRSS:'):
                    return before - int(line.split()[1])
    except Exception:
        return None


def _log_rss(tag):
    """内存探针（Linux /proc）：RSS + gc 存活对象数 + malloc_trim 碎片实验。
    判读：RSS 涨而"存活对象"走平 → 碎片/水位（非泄露）；trim 后 RSS 骤降 → glibc 碎片实锤。
    ▸ 存活对象 = gc 追踪的容器对象（dict/list 等）计数，字符串/数字不受追踪不计入；
    ▸ gc.get_objects() 会临时生成指针大列表（每对象 8 字节，取完 len 即释放），对读数影响可控；
    ▸ 探针结尾会顺手 trim，归还的空闲页即下一阶段的真实基线。
    非 Linux 静默跳过。"""
    rss_kb = None
    try:
        with open('/proc/self/status', encoding='utf-8') as f:
            for line in f:
                if line.startswith('VmRSS:'):
                    rss_kb = int(line.split()[1])
                    break
    except Exception:
        return
    import gc as _gc
    try:
        live_n = len(_gc.get_objects())
    except Exception:
        live_n = -1
    trim_note = ''
    freed = _malloc_trim_now()
    if freed is not None and freed > 0:
        trim_note = f'，trim后={rss_kb - freed}kB(降{freed}kB)'
    logger.info(f'[内存] {tag}: RSS={rss_kb}kB 存活对象={live_n}{trim_note}')


def _digest_province_stats(carrier_key, prov, r, storage_ref, crawl_time):
    """省份级内存消化（流水线释放的核心）：
    将该省原始条目一次性转成统计摘要（dist/breakdown/去重键子集/last_crawl/today），
    挂到 r['crawl_result']['_digested']，随后释放原始条目——内存随即回落。

    与 _build_and_save_stats 的省级计算逐字段等价（纯搬家，不改任何口径）：
    ▸ 跨省去重由各包子集在 stats 组装时做集合并集（结合律保证与全量合并一致）；
    ▸ 变更日志在本省 _process_prov 内已写入 storage_ref 缓冲，此处读到即为本轮内容，
      与原统计阶段从主缓冲读取的一致；
    ▸ 无 crawl_result（PW 回退重试等）时为空操作。
    """
    crawl_result = r.get('crawl_result') if isinstance(r, dict) else None
    if not crawl_result:
        return
    items = crawl_result.get('items')
    if items is None:
        return  # 无原始数据（rebuild 路径等），组装阶段走旧数据回退分支

    try:
        changes = crawl_result.get('changes', {})
        crawl_status = crawl_result.get('crawl_status', 'success')
        data_crawl_time = crawl_result.get('data_crawl_time', crawl_time)

        dist = compute_dist(items)
        breakdown = compute_breakdown(items)

        last_crawl = {}
        for change_type, key in (('added', 'added'), ('removed', 'removed'), ('modified', 'changed')):
            for c in changes.get(change_type, []):
                attr = c.get('attr', '') or '0'
                last_crawl.setdefault(attr, {'added': 0, 'removed': 0, 'changed': 0})
                last_crawl[attr][key] += 1

        from datetime import datetime as _dt, timedelta as _td
        # 「今日」窗口锚定北京时间 0 点（ts 全链路 UTC 存储：+8h 转北京时间取 0 点，再 -8h 换回 UTC 比较）
        _bj = _dt.strptime(crawl_time, '%Y-%m-%dT%H:%M:%S.%fZ') + _td(hours=8)
        today_start = _bj.replace(hour=0, minute=0, second=0, microsecond=0) - _td(hours=8)
        today_start_iso = today_start.strftime('%Y-%m-%dT%H:%M:%S.000Z')
        changelog_path = f'{carrier_key}/changelogs/changelog_{prov["code"]}.json'
        changelog_data = storage_ref.read_json(changelog_path) or {}
        today_entries = [e for e in (changelog_data.get('logs') or [])
                         if (e.get('ts') or '') >= today_start_iso]
        today = {}
        for c in today_entries:
            attr = c.get('attr', '') or '0'
            ctype = c.get('type')
            if ctype in ('added', 'removed', 'changed'):
                today.setdefault(attr, {'added': 0, 'removed': 0, 'changed': 0})
                today[attr][ctype] += 1

        dedup_keys = set()
        for it in items:
            n = (it.get('name') or '').strip()
            if not n:
                continue
            # 去重键 = 方案编号：全国方案跨省同码只计一次；同名不同码是不同方案不合并；无编号回退名称
            code = ((it.get('fields') or {}).get('方案编号') or '').strip()
            dedup_keys.add('c:' + code if code else 'n:' + n)
    except Exception as e:
        # 消化失败绝不影响采集主流程：保留原始条目，stats 组装期走原有计算路径（数据不变）
        logger.warning(f'{carrier_display(carrier_key)} {prov.get("name", "")}: 省级消化失败，回退统计期计算: {e}')
        return

    crawl_result['_digested'] = {
        'province_data': {
            'code': prov['code'],
            'name': prov['name'],
            'breakdown': breakdown,
            'data_crawl_time': data_crawl_time,
            'crawl_status': crawl_status,
            'last_crawl': last_crawl,
            'today': today,
            'dist': dist,
            'volatility': crawl_result.get('volatility'),
            'consecutive_degrade_count': crawl_result.get('consecutive_degrade_count', 0),
        },
        'dedup_keys': dedup_keys,
    }
    # 摘要已生成，原始条目立即释放（内存回落的关键动作）
    crawl_result['items'] = None
    # 实时归还 glibc 碎片：解析峰值水位不再跨省累积（服务器内存紧张时的关键防线）
    _malloc_trim_now()


def crawl_one_carrier(config, carrier_key, storage, old_stats, crawl_time):
    """
    采集单个运营商的所有目标省份数据。

    该函数可在独立线程中运行，每个运营商使用各自独立的 storage 实例，
    写入各自的 _buffer，互不干扰。全部完成后由主线程合并 buffer。

    返回 dict:
        crawl_results: {province_name: result_dict}
        success_count: 成功省份数
        fail_count: 失败省份数
        skipped_provinces: 跳过的省份名列表
        degraded_provinces: 降级的省份名列表
        volatility_warnings: 波动预警列表
        partial_warnings: 部分分类失败预警列表
        api: 需要主线程统一 close 的 API 实例
    """
    _carrier_ctx.carrier = CARRIER_DISPLAY_NAMES.get(carrier_key, carrier_key)
    logger.info(f'══════ 开始采集运营商: {carrier_display(carrier_key)} ══════')
    carrier_cfg = get_carrier_config(config, carrier_key)
    storage.set_carrier_key(carrier_key)

    target_provinces = get_target_provinces(carrier_cfg, carrier_key)
    storage.set_active_provinces(carrier_key, [p['code'] for p in target_provinces])
    _carrier_field = _CARRIER_CODE_FIELD.get(carrier_key, '')
    _all_carrier_provs = [p for p in PROVINCES if p.get(_carrier_field, '')] if _carrier_field else list(PROVINCES)
    if len(target_provinces) == len(_all_carrier_provs):
        logger.info(f'目标省份: 全部 {len(_all_carrier_provs)} 个省份')
    else:
        logger.info(f'目标省份: {len(target_provinces)} 个 ({[p["code"] for p in target_provinces]})')

    crawl_results = {}
    success_count = 0
    fail_count = 0
    volatility_warnings = []
    partial_warnings = []
    skipped_provinces = []
    degraded_provinces = []
    province_diags = []
    carrier_start = time.time()

    # 省份并发数：运营商级覆盖 carriers.<key>.crawl.province_workers 优先，
    # 未配置（或为 0/负数）时回落全局 schedule.province_workers。
    # 各运营商风控松紧不同，可按需差异化：如 cmcc=5、cucc=2。
    global_pw = config.get('schedule', {}).get('province_workers', 1)
    carrier_pw = carrier_cfg.get('crawl', {}).get('province_workers')
    province_workers = int(carrier_pw) if carrier_pw and int(carrier_pw) > 0 else int(global_pw)
    if carrier_pw and int(carrier_pw) > 0 and int(carrier_pw) != int(global_pw):
        logger.info(f'{carrier_display(carrier_key)}: 省份并发覆盖 province_workers={province_workers} (全局={global_pw})')
    ctcc_direct_mode = carrier_cfg.get('crawl', {}).get('direct_mode', 'prefer_direct') if carrier_key == 'ctcc' else ''

    use_concurrent = (
        province_workers > 1
        and len(target_provinces) > 1
        and not (carrier_key == 'ctcc' and ctcc_direct_mode == 'playwright_only')
    )

    if use_concurrent:
        logger.info(f'省份并发采集已开启 (province_workers={province_workers})')

    def _process_prov(prov, prov_api, prov_storage, pw_fallback_mode=False, prov_index=None):
        prov_start = time.time()
        prov_short = prov['code']
        prov_name = prov['name']
        # 省份并发子线程需显式设置运营商标识（threading.local 不跨线程继承，
        # 否则该线程内的所有日志都显示 [系统]）
        _carrier_ctx.carrier = CARRIER_DISPLAY_NAMES.get(carrier_key, carrier_key)
        if prov_index is not None:
            logger.info(f'采集 {prov_name} ({prov_short}) [{prov_index + 1}/{len(target_provinces)}]...')
        else:
            logger.info(f'采集 {prov_name} ({prov_short})...')

        result = {
            'prov_name': prov_name,
            'crawl_result': None,
            'success': False,
            'skipped': False,
            'degraded': False,
            'volatility_warning': None,
            'partial_warning': None,
            'pw_needs_fallback': False,
        }

        try:
            if pw_fallback_mode:
                try:
                    data = crawl_province(prov_api, prov, carrier_cfg, carrier_key)
                except Exception as e:
                    data = {
                        'province': prov_name, 'code': prov_short,
                        'items': [], 'total': 0, 'status': 'error',
                        'failed_categories': [str(e)[:100]],
                    }
            elif carrier_key == 'ctcc' and ctcc_direct_mode != 'playwright_only':
                try:
                    data = prov_api.crawl_direct(prov_short, prov_name, carrier_key)
                    logger.info(f'  电信直连采集完成: {data["total"]} 条')
                except Exception as e:
                    if ctcc_direct_mode == 'direct_only':
                        logger.warning(f'  电信直连失败 (仅直连模式): {e}')
                        data = {
                            'province': prov_name, 'code': prov_short,
                            'items': [], 'total': 0, 'status': 'error',
                            'failed_categories': [str(e)[:100]],
                        }
                    else:
                        log_msg = '电信直连失败, 回退 Playwright' if not use_concurrent else '电信直连失败, 标记 PW 回退'
                        logger.warning(f'  {log_msg}: {e}')
                        result['pw_needs_fallback'] = True
                        return result
            else:
                try:
                    data = crawl_province(prov_api, prov, carrier_cfg, carrier_key)
                except Exception as e:
                    data = {
                        'province': prov_name, 'code': prov_short,
                        'items': [], 'total': 0, 'status': 'error',
                        'failed_categories': [str(e)[:100]],
                    }

            result['diag'] = data.get('diag')
            prov_time = f'{(time.time() - prov_start):.2f}'
            items = data.get('items', [])
            dp_cfg = config.get('data_processing', {})
            items = _filter_test_items(items, dp_cfg)

            try:
                old_snap = prov_storage.read_json(f'{carrier_key}/snapshots/snapshot_{prov_short}.json')
            except RuntimeError as e:
                logger.warning(f'  {prov_name}: 旧snapshot读取失败, 视为首次采集直接写入新数据: {e}')
                old_snap = None
            if old_snap and old_snap.get('items'):
                old_kept = _filter_test_items(old_snap['items'], dp_cfg)
                if len(old_kept) != len(old_snap['items']):
                    old_snap = dict(old_snap, items=old_kept)
            old_items = (old_snap or {}).get('items', [])
            old_count = len(old_items)
            new_count = len(items)

            if data['status'] == 'failed' or data['status'] == 'error':
                logger.warning(f'  {prov_name}: 采集失败, 耗时={prov_time}s')
                _fail_degrade_count = 0
                if old_stats:
                    _fail_prov_stats = _find_province_in_stats(old_stats, carrier_key, prov_short)
                    if _fail_prov_stats:
                        _fail_degrade_count = _fail_prov_stats.get('consecutive_degrade_count', 0)
                result['crawl_result'] = {
                    'items': old_items,
                    'changes': {'added': [], 'removed': [], 'modified': []},
                    'data_crawl_time': (old_snap or {}).get('data_crawl_time', ''),
                    'crawl_status': 'failed',
                    'from_history': True,
                    'consecutive_degrade_count': _fail_degrade_count,
                }
                result['skipped'] = True
                return result

            if data['status'] == 'partial':
                failed_cats = data.get('failed_categories', [])
                result['partial_warning'] = {'province': prov_name, 'failed_categories': failed_cats}
                logger.warning(f'  {prov_name}: 部分分类采集失败({len(failed_cats)}个), 继续走正常流程')
                # 失败分类沿用旧快照条目（数据无损、杜绝假下架）：
                # ▸ 旧数据来源与快照对比同源（prov_storage.read_json：缓冲→本地缓存→远端，均可取到上一轮）；
                # ▸ 仅填补失败分类的缺口，已成功分类的新条目一律不动；同 id 以本轮新抓为准；
                # ▸ 合并后再做波动检查，避免缺分类造成的假骤降误拦
                failed_keys = {(k.get('attr'), k.get('t1'), k.get('t2')) for k in data.get('failed_cat_keys', [])}
                if failed_keys and old_items:
                    fresh_ids = {it['id'] for it in items}
                    restored = 0
                    for old_it in old_items:
                        if ((old_it.get('tariff_attr', ''), old_it.get('type1', ''), old_it.get('type2', '')) in failed_keys
                                and old_it.get('id') not in fresh_ids):
                            items.append(old_it)
                            fresh_ids.add(old_it['id'])
                            restored += 1
                    if restored:
                        new_count = len(items)
                        logger.warning(f'  {prov_name}: 失败分类沿用旧条目 {restored} 条（合计 {new_count} 条）')

            vol = check_volatility(old_count, new_count, carrier_cfg)
            if vol['level'] != 'normal':
                result['volatility_warning'] = {'province': prov_name, **vol}
                logger.warning(f'  {prov_name}: 波动 {vol["ratio"] * 100:.1f}%, {vol["level"]}')

            degrade_threshold = carrier_cfg['volatility'].get('degrade_auto_recover_threshold', 0)
            old_degrade_count = 0
            if degrade_threshold > 0 and old_stats:
                _old_prov_stats = _find_province_in_stats(old_stats, carrier_key, prov_short)
                if _old_prov_stats:
                    old_degrade_count = _old_prov_stats.get('consecutive_degrade_count', 0)

            degrade_auto_recovered = False
            new_degrade_count = 0

            if vol['level'] == 'hard_reject':
                if degrade_threshold > 0 and old_degrade_count >= degrade_threshold:
                    logger.warning(
                        f'  {prov_name}: 连续{old_degrade_count}轮骤变拦截，'
                        f'达到自动恢复阈值({degrade_threshold})，放行覆盖'
                    )
                    new_degrade_count = 0
                    degrade_auto_recovered = True
                else:
                    new_degrade_count = old_degrade_count + 1

                    if vol.get('direction') == 'decrease':
                        logger.warning(f'  {prov_name}: 数据骤降 ({old_count}→{new_count}), 保留旧数据不覆盖 (降级计数:{new_degrade_count}/{degrade_threshold})')
                        result['crawl_result'] = {
                            'items': old_items,
                            'changes': {'added': [], 'removed': [], 'modified': []},
                            'data_crawl_time': (old_snap or {}).get('data_crawl_time', ''),
                            'crawl_status': 'sudden_change',
                            'volatility': vol,
                            'from_history': True,
                            'consecutive_degrade_count': new_degrade_count,
                        }
                        result['degraded'] = True
                        result['skipped'] = True
                        return result
                    else:
                        dup_ratio = data.get('content_duplicate_ratio', 0)
                        dup_threshold = carrier_cfg['volatility'].get('surge_duplicate_threshold', 0.5)
                        if dup_ratio >= dup_threshold:
                            logger.warning(f'  {prov_name}: 数据骤增且重复率 {dup_ratio * 100:.1f}% >= {dup_threshold * 100:.0f}%, 保留旧数据不覆盖 (降级计数:{new_degrade_count}/{degrade_threshold})')
                            result['crawl_result'] = {
                                'items': old_items,
                                'changes': {'added': [], 'removed': [], 'modified': []},
                                'data_crawl_time': (old_snap or {}).get('data_crawl_time', ''),
                                'crawl_status': 'surge_duplicate',
                                'volatility': vol,
                                'from_history': True,
                                'consecutive_degrade_count': new_degrade_count,
                            }
                            result['degraded'] = True
                            result['skipped'] = True
                            return result
                        else:
                            logger.warning(f'  {prov_name}: 数据骤增但内容不重复, 走正常覆盖')
                            new_degrade_count = 0

            new_snap = build_snapshot(prov_short, prov_name, items, crawl_time, crawl_time, carrier=carrier_key)

            if old_snap is None:
                logger.info(f'  {prov_name}: 首次建立基线 ({new_count} 条), 不通知')
                prov_storage.write_json(f'{carrier_key}/snapshots/snapshot_{prov_short}.json', new_snap)
                result['crawl_result'] = {
                    'items': items,
                    'changes': {'added': [], 'removed': [], 'modified': []},
                    'data_crawl_time': crawl_time,
                    'crawl_status': 'success',
                    'volatility': vol if vol['level'] != 'normal' else None,
                    'consecutive_degrade_count': 0,
                }
                result['success'] = True
                return result

            diff_norm = dp_cfg.get('html_strip_before_diff', False)
            structure_upgraded = False
            sud_cfg = dp_cfg.get('structure_upgrade_detect', True)
            if sud_cfg and _structure_upgraded(old_items, items):
                diff_result = diff_snapshots(old_snap, new_snap, carrier=carrier_key, norm=diff_norm)
                _suppressed = len(diff_result['modified'])
                diff_result['modified'] = []
                structure_upgraded = True
                logger.info(f'  {prov_name}: 字段结构升级，抑制 {_suppressed} 条 modified 误报，'
                            f'保留新增 {len(diff_result["added"])} / 下架 {len(diff_result["removed"])}')
            else:
                diff_result = diff_snapshots(old_snap, new_snap, carrier=carrier_key, norm=diff_norm)

            vfr_cfg = dp_cfg.get('verify_fake_removed', {})
            old_items_map = {it['id']: it for it in old_items}
            verified_removed, fake_removed_count = _drop_fake_removed(
                diff_result['removed'], old_items_map, vfr_cfg
            )

            baseline_dt = None
            if old_snap and old_snap.get('crawl_time'):
                _ct = old_snap['crawl_time']
                _m = re.match(r'(\d{4})-(\d{2})-(\d{2})', str(_ct))
                if _m:
                    try:
                        baseline_dt = datetime.date(int(_m.group(1)), int(_m.group(2)), int(_m.group(3)))
                    except Exception:
                        pass
            new_items_map = {it['id']: it for it in items}
            verified_added, fake_added_count = _drop_stale_added(
                diff_result['added'], new_items_map, vfr_cfg, baseline_dt
            )

            changes = {
                'added': verified_added,
                'removed': verified_removed,
                'modified': diff_result['modified'],
            }
            if structure_upgraded:
                changes['note'] = 'structure_upgraded'

            prov_storage.write_json(f'{carrier_key}/snapshots/snapshot_{prov_short}.json', new_snap)

            _crawl_status = 'degrade_auto_recovered' if degrade_auto_recovered else 'success'
            result['crawl_result'] = {
                'items': items,
                'changes': changes,
                'data_crawl_time': crawl_time,
                'crawl_status': _crawl_status,
                'volatility': vol if vol['level'] != 'normal' else None,
                'consecutive_degrade_count': new_degrade_count,
            }

            has_changes = bool(changes['added'] or changes['removed'] or changes['modified'])
            status_tag = '有变更' if has_changes else '无变更'
            logger.info(f'  {prov_name}: {status_tag}, {new_count} 条, 耗时={prov_time}s')

            if has_changes:
                timestamp = crawl_time
                entries = build_changelog_entries(changes, timestamp)
                old_cl = prov_storage.read_json(f'{carrier_key}/changelogs/changelog_{prov_short}.json')
                old_logs = (old_cl or {}).get('logs', [])
                new_logs = entries + old_logs

                retention = config['changelog']['retention_days']
                cutoff = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=retention)).isoformat() + 'Z'
                new_logs = [e for e in new_logs if e.get('ts', '') >= cutoff]

                changelog = {
                    'version': CHANGELOG_VERSION,
                    'province': prov_name,
                    'province_code': prov_short,
                    'carrier': carrier_key,
                    'retention_days': retention,
                    'logs': new_logs,
                }
                prov_storage.write_json(f'{carrier_key}/changelogs/changelog_{prov_short}.json', changelog)

            result['success'] = True

        except Exception as e:
            logger.error(f'  {prov_name}: 采集异常: {e}', exc_info=True)
            result['crawl_result'] = {
                'items': [],
                'changes': {'added': [], 'removed': [], 'modified': []},
                'data_crawl_time': crawl_time,
                'crawl_status': 'error',
                'from_history': True,
                'consecutive_degrade_count': 0,
            }
            result['skipped'] = True

        return result

    def _merge_prov_result(r):
        nonlocal success_count, fail_count
        if r['crawl_result'] is not None:
            crawl_results[r['prov_name']] = r['crawl_result']
        if r.get('diag'):
            province_diags.append(r['diag'])
        if r['success']:
            success_count += 1
        else:
            fail_count += 1
        if r['skipped']:
            skipped_provinces.append(r['prov_name'])
        if r['degraded']:
            degraded_provinces.append(r['prov_name'])
        if r['volatility_warning']:
            volatility_warnings.append(r['volatility_warning'])
        if r['partial_warning']:
            partial_warnings.append(r['partial_warning'])

    def _prov_delay():
        delay_min = carrier_cfg['crawl']['delay_min']
        delay_max = carrier_cfg['crawl']['delay_max']
        jitter = carrier_cfg['crawl']['jitter_ratio']
        delay_sec = delay_min + random.randint(0, delay_max - delay_min)
        jitter_offset = delay_sec * jitter * (2 * random.random() - 1)
        delay_sec = max(1, delay_sec + jitter_offset)
        logger.info(f'  等待 {delay_sec:.1f}s 后采集下一省...')
        time.sleep(delay_sec)

    pw_fallback_provs = []
    api_to_close = None

    try:
        if use_concurrent:
            with ThreadPoolExecutor(max_workers=min(province_workers, len(target_provinces))) as executor:
                futures = {}
                for prov in target_provinces:
                    prov_api = create_carrier_api(carrier_key, carrier_cfg)
                    prov_storage = create_storage(config)
                    prov_storage.set_carrier_key(carrier_key)
                    prov_storage.set_all_carrier_keys(config.get('carriers', {}).keys())
                    prov_storage.set_active_provinces(carrier_key, [p['code'] for p in target_provinces])
                    future = executor.submit(_process_prov, prov, prov_api, prov_storage)
                    futures[future] = (prov, prov_api, prov_storage)

                for future in as_completed(futures):
                    prov, prov_api, prov_storage = futures[future]
                    try:
                        r = future.result()
                    except Exception as e:
                        logger.error(f'省份 {prov["name"]} 线程异常: {e}', exc_info=True)
                        r = {
                            'prov_name': prov['name'],
                            'crawl_result': {
                                'items': [], 'changes': {'added': [], 'removed': [], 'modified': []},
                                'data_crawl_time': crawl_time, 'crawl_status': 'error',
                                'from_history': True, 'consecutive_degrade_count': 0,
                            },
                            'success': False, 'skipped': True, 'degraded': False,
                            'volatility_warning': None, 'partial_warning': None,
                            'pw_needs_fallback': False,
                        }
                    # 省级流水线：采集完成立即消化并释放原始条目（变更日志已在 prov_storage 缓冲）
                    _digest_province_stats(carrier_key, prov, r, prov_storage, crawl_time)
                    if r['pw_needs_fallback']:
                        pw_fallback_provs.append(prov)
                    else:
                        _merge_prov_result(r)
                    if hasattr(prov_api, 'close'):
                        try:
                            prov_api.close()
                        except Exception:
                            pass
                    storage.merge_buffer(prov_storage)
                    for ck, codes in prov_storage.all_active_provinces.items():
                        storage.set_active_provinces(ck, codes)

            if pw_fallback_provs:
                api = create_carrier_api(carrier_key, carrier_cfg)
                logger.info(f'电信 PW 回退: {len(pw_fallback_provs)} 个省份将串行采集')
                for i, prov in enumerate(pw_fallback_provs):
                    r = _process_prov(prov, api, storage, pw_fallback_mode=True)
                    _digest_province_stats(carrier_key, prov, r, storage, crawl_time)
                    _merge_prov_result(r)
                    if i < len(pw_fallback_provs) - 1:
                        _prov_delay()
                api_to_close = api

        else:
            api = create_carrier_api(carrier_key, carrier_cfg)
            for i, prov in enumerate(target_provinces):
                r = _process_prov(prov, api, storage, prov_index=i)
                if r['pw_needs_fallback']:
                    r_pw = _process_prov(prov, api, storage, pw_fallback_mode=True, prov_index=i)
                    _digest_province_stats(carrier_key, prov, r_pw, storage, crawl_time)
                    _merge_prov_result(r_pw)
                else:
                    _digest_province_stats(carrier_key, prov, r, storage, crawl_time)
                    _merge_prov_result(r)
                if i < len(target_provinces) - 1:
                    _prov_delay()
            api_to_close = api

        logger.info(f'运营商 {carrier_display(carrier_key)} 采集完成: 成功={success_count}, 失败={fail_count}')
    except Exception as e:
        logger.error(f'运营商 {carrier_display(carrier_key)} 采集异常: {e}', exc_info=True)
        processed_names = set(crawl_results.keys())
        unprocessed = [p['name'] for p in target_provinces if p['name'] not in processed_names]
        fail_count = len(unprocessed)
        skipped_provinces.extend(unprocessed)

    diag_data = {
        'crawl_time': crawl_time,
        'carrier': carrier_key,
        'provinces': province_diags,
        'total_ms': int((time.time() - carrier_start) * 1000),
    }
    _log_rss(f'{carrier_display(carrier_key)} 采集完成')
    try:
        storage.write_json(f'{carrier_key}/_diag.json', diag_data)
    except Exception as e:
        logger.warning(f'诊断数据写入失败: {e}')

    return {
        'crawl_results': crawl_results,
        'success_count': success_count,
        'fail_count': fail_count,
        'skipped_provinces': skipped_provinces,
        'degraded_provinces': degraded_provinces,
        'volatility_warnings': volatility_warnings,
        'partial_warnings': partial_warnings,
        'api': api_to_close,
    }


def _find_province_in_stats(stats, carrier_key, province_code):
    if not stats:
        return None
    provinces = ((stats.get('carriers') or {}).get(carrier_key) or {}).get('provinces') or []
    for p in provinces:
        if p.get('code') == province_code:
            return p
    return None


def rebuild_stats_from_history(config, storage):
    """
    从旧 stats.json 重建 stats，不执行任何网络采集，不读取 snapshot/changelog。
    用于仅修改了 stats 结构或前端时，避免全量重采。
    """
    carriers = config.get('carriers', {})
    enabled_carriers = [k for k, v in carriers.items() if v.get('enabled', True)]
    if not enabled_carriers:
        logger.error('没有启用任何运营商')
        sys.exit(1)

    storage.set_all_carrier_keys(carriers.keys())
    crawl_time = now_iso()
    crawl_start = time.time()

    old_stats = storage.read_json('stats.json')

    all_crawl_results = {}
    all_success_count = {}
    all_fail_count = {}

    for carrier_key in enabled_carriers:
        carrier_cfg = get_carrier_config(config, carrier_key)
        target_provinces = get_target_provinces(carrier_cfg, carrier_key)
        storage.set_carrier_key(carrier_key)
        storage.set_active_provinces(carrier_key, [p['code'] for p in target_provinces])

        crawl_results = {}
        success_count = 0
        fail_count = 0
        for prov in target_provinces:
            prov_short = prov['code']
            old_prov = _find_province_in_stats(old_stats, carrier_key, prov_short)
            if old_prov and old_prov.get('dist'):
                crawl_results[prov['name']] = {
                    'items': None,
                    'changes': {'added': [], 'removed': [], 'modified': []},
                    'data_crawl_time': old_prov.get('data_crawl_time', crawl_time),
                    'crawl_status': 'success',
                    'consecutive_degrade_count': old_prov.get('consecutive_degrade_count', 0),
                }
                success_count += 1
            else:
                crawl_results[prov['name']] = {
                    'items': None,
                    'changes': {'added': [], 'removed': [], 'modified': []},
                    'data_crawl_time': crawl_time,
                    'crawl_status': 'no_snapshot',
                    'consecutive_degrade_count': 0,
                }
                fail_count += 1

        all_crawl_results[carrier_key] = crawl_results
        all_success_count[carrier_key] = success_count
        all_fail_count[carrier_key] = fail_count
        logger.info(f'{carrier_display(carrier_key)}: 从旧 stats 重建 {success_count}/{len(target_provinces)} 省')

    crawl_duration_ms = int((time.time() - crawl_start) * 1000)
    _build_and_save_stats(config, storage, all_crawl_results, crawl_time, crawl_duration_ms, all_success_count, all_fail_count, old_stats)
    refresh_public_config(storage)
    bake_community_data(storage, config)
    storage.commit(message=f'stats rebuild {crawl_time[:10]}', skip_unchanged_download=True)
    logger.info(f'stats 重建完成，耗时 {crawl_duration_ms / 1000:.2f}s')


def run():
    logger.info('===== ChinaMNOs 采集端 v%s 启动 =====' % SCRIPT_VERSION)
    config = parse_and_validate_config()
    storage = create_storage(config)

    if _is_deploy_frontend:
        logger.info('模式: 仅部署前端文件 (--deploy-frontend)')
        carriers = config.get('carriers', {})
        storage.set_all_carrier_keys(carriers.keys())
        all_prov_codes = [p['code'] for p in PROVINCES]
        for ck in carriers:
            storage.set_active_provinces(ck, all_prov_codes)
        refresh_public_config(storage)
        bake_community_data(storage, config, carrier_keys=carriers.keys())
        storage.commit(message='frontend deploy', skip_unchanged_download=True)
        logger.info('前端文件部署完成')
        return

    if _is_rebuild_stats:
        logger.info('模式: 从已有 stats 重建 (--rebuild-stats)')
        rebuild_stats_from_history(config, storage)
        return

    carriers = config.get('carriers', {})
    enabled_carriers = [k for k, v in carriers.items() if v.get('enabled', True)]
    if not enabled_carriers:
        # 资费源全关时不再直接退出：公告采集与资费解耦，支持「仅公告」运行
        if (config.get('announce') or {}).get('enabled', True):
            logger.warning('资费源全部未启用，本次仅执行公告采集')
            _ann_only_storage = create_storage(config)
            _ann_only_storage.set_all_carrier_keys(carriers.keys())
            try:
                fetch_announcements(config, _ann_only_storage)
            except Exception as _ann_e:
                logger.warning('[announce] 公告采集异常: %s' % str(_ann_e)[:120])
            refresh_public_config(_ann_only_storage)
            _ann_only_storage.commit(message='announce only %s' % now_iso()[:10])
            return
        logger.error('没有启用任何运营商 (carriers.*.enabled 全为 false)')
        sys.exit(1)

    # 传入所有配置过的运营商（含已禁用），供存储层清理已禁用运营商的残留数据
    storage.set_all_carrier_keys(carriers.keys())
    logger.info(f'启用的运营商: {enabled_carriers}')

    global _active_apis
    _active_apis = []
    crawl_time = now_iso()
    crawl_start = time.time()

    all_crawl_results = {}
    all_success_count = {}
    all_fail_count = {}
    all_skipped = {}
    all_degraded = {}
    all_volatility = {}
    all_partial = {}

    old_stats = storage.read_json('stats.json')

    schedule_cfg = config.get('schedule', {})
    concurrent = schedule_cfg.get('concurrent_carriers', False)
    max_workers = schedule_cfg.get('max_workers', 4)

    if concurrent and len(enabled_carriers) > 1:
        logger.info(f'运营商并发采集已开启 (max_workers={max_workers}), {len(enabled_carriers)} 个运营商将并行执行')

        carrier_storages = {}
        future_map = {}

        with ThreadPoolExecutor(max_workers=max(1, min(max_workers, len(enabled_carriers)))) as executor:
            for carrier_key in enabled_carriers:
                c_storage = create_storage(config)
                c_storage.set_all_carrier_keys(carriers.keys())
                carrier_storages[carrier_key] = c_storage
                future = executor.submit(
                    crawl_one_carrier, config, carrier_key, c_storage, old_stats, crawl_time
                )
                future_map[future] = carrier_key

            for future in as_completed(future_map):
                carrier_key = future_map[future]
                try:
                    result = future.result()
                except Exception as e:
                    logger.error(f'运营商 {carrier_display(carrier_key)} 线程异常: {e}', exc_info=True)
                    _tgt_provs = get_target_provinces(get_carrier_config(config, carrier_key), carrier_key)
                    result = {
                        'crawl_results': {},
                        'success_count': 0,
                        'fail_count': len(_tgt_provs),
                        'skipped_provinces': [p['name'] for p in _tgt_provs],
                        'degraded_provinces': [],
                        'volatility_warnings': [],
                        'partial_warnings': [],
                        'api': None,
                    }

                all_crawl_results[carrier_key] = result['crawl_results']
                all_success_count[carrier_key] = result['success_count']
                all_fail_count[carrier_key] = result['fail_count']
                all_skipped[carrier_key] = result['skipped_provinces']
                all_degraded[carrier_key] = result['degraded_provinces']
                all_volatility[carrier_key] = result['volatility_warnings']
                all_partial[carrier_key] = result['partial_warnings']
                if result.get('api') is not None:
                    _active_apis.append(result['api'])

        for carrier_key in enabled_carriers:
            c_storage = carrier_storages.get(carrier_key)
            if c_storage is not None:
                storage.merge_buffer(c_storage)
                for ck, codes in c_storage.all_active_provinces.items():
                    storage.set_active_provinces(ck, codes)
    else:
        for carrier_key in enabled_carriers:
            result = crawl_one_carrier(config, carrier_key, storage, old_stats, crawl_time)
            if result.get('api') is not None:
                _active_apis.append(result['api'])
            all_crawl_results[carrier_key] = result['crawl_results']
            all_success_count[carrier_key] = result['success_count']
            all_fail_count[carrier_key] = result['fail_count']
            all_skipped[carrier_key] = result['skipped_provinces']
            all_degraded[carrier_key] = result['degraded_provinces']
            all_volatility[carrier_key] = result['volatility_warnings']
            all_partial[carrier_key] = result['partial_warnings']

    crawl_duration_ms = int((time.time() - crawl_start) * 1000)
    total_success = sum(all_success_count.values())
    total_fail = sum(all_fail_count.values())
    logger.info(f'全部采集完成: 成功={total_success}, 失败={total_fail}, 耗时={crawl_duration_ms / 1000:.2f}s')
    _log_rss('全部采集完成')

    _build_and_save_stats(config, storage, all_crawl_results, crawl_time, crawl_duration_ms, all_success_count, all_fail_count, old_stats)
    # ── 公告监测（与资费采集隔离：失败仅记日志，不影响资费上传）──
    _announce_new = None
    try:
        _announce_new = fetch_announcements(config, storage)
    except Exception as _ann_e:
        logger.warning('[announce] 公告采集异常(已忽略，不影响资费): %s' % str(_ann_e)[:120])

    refresh_public_config(storage)
    bake_community_data(storage, config)
    storage.commit(message=f'tariff update {crawl_time[:10]}')
    _log_rss('部署完成')

    for _api in _active_apis:
        if hasattr(_api, 'close'):
            try:
                _api.close()
            except Exception as _e:
                logger.warning(f'关闭 {_api.__class__.__name__} 资源失败: {_e}')

    if _is_init:
        logger.info('初始化模式, 不发送通知')
        return

    all_skipped_flat = []
    for k, v in all_skipped.items():
        for p in v:
            all_skipped_flat.append(f'{carrier_display(k)}:{p}')

    all_degraded_flat = []
    for k, v in all_degraded.items():
        for p in v:
            all_degraded_flat.append(f'{carrier_display(k)}:{p}')

    all_vol_flat = []
    for k, warns in all_volatility.items():
        for w in warns:
            all_vol_flat.append(f'{carrier_display(k)}:{w["province"]}:{w["ratio"] * 100:.0f}%')

    all_partial_flat = []
    for k, warns in all_partial.items():
        for w in warns:
            cats = '、'.join(w.get('failed_categories', [])) or '未知'
            all_partial_flat.append(f'{carrier_display(k)}:{w["province"]}({cats})')

    if all_skipped_flat and should_notify('error', config):
        err_msg = f'资费监控疑似抓取不全，已跳过对比：{", ".join(all_skipped_flat)}'
        if all_vol_flat:
            err_msg += f'\n波动预警: {", ".join(all_vol_flat)}'
        send_notification('资费监控-异常提醒', build_error_message(err_msg), config)

    if not all_skipped_flat and all_vol_flat and should_notify('error', config):
        vol_msg = f'资费监控波动预警（数据已正常更新）：{", ".join(all_vol_flat)}'
        send_notification('资费监控-波动预警', build_error_message(vol_msg), config)

    if all_partial_flat and should_notify('error', config):
        partial_msg = f'资费监控部分分类采集失败（数据已正常更新）：{", ".join(all_partial_flat)}'
        send_notification('资费监控-部分采集提醒', build_error_message(partial_msg), config)

    if total_success == 0 and total_fail > 0 and should_notify('all_fail', config):
        all_fail_flat = []
        for k, v in all_fail_count.items():
            if v > 0:
                all_fail_flat.append(f'{carrier_display(k)}:{v}省')
        fail_msg = f'全部省份采集失败：{", ".join(all_fail_flat)}'
        send_notification('资费监控-全部失败', build_error_message(fail_msg), config)

    if all_degraded_flat and should_notify('degrade', config):
        deg_msg = f'资费监控降级模式(仅对比不覆盖)：{", ".join(all_degraded_flat)}'
        send_notification('资费监控-降级提醒', build_error_message(deg_msg), config)

    has_any_change = False
    for carrier_key, crawl_results in all_crawl_results.items():
        carrier_label = CARRIER_DISPLAY_NAMES.get(carrier_key, carrier_key)
        carrier_cfg = get_carrier_config(config, carrier_key)
        summary = build_change_summary(carrier_key, crawl_results, carrier_cfg)
        if summary:
            has_any_change = True
            if should_notify('change', config):
                send_notification(f'{carrier_label}资费监控-变更通知', summary, config)
    if not has_any_change and not all_skipped_flat and not all_degraded_flat and not all_vol_flat and not all_partial_flat and should_notify('no_change', config):
        send_notification('资费监控-无变化', build_nochange_message(), config)

    # 采集播报（ext_msg 通道）：全量整理 digest → 叫醒分发（ext_msg 关闭/无变化时内部自动跳过）
    write_collector_digest(config, all_crawl_results, _announce_new)


# ======================================================================
# 公告监测（announce monitoring）
#   - 与资费采集物理隔离：全部函数以 _ann/ANN_ 前缀，不触碰资费类与函数
#   - 任一源失败仅记日志跳过，不影响其他源与资费管线
#   - 产出 data/{carrier}/announce.json，经 storage.write_json 自动进上传批次
#   - 接口协议/省份参数均已逐源实测核对（docs/announce-monitoring-spec.md）
# ======================================================================

_ANN_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# 移动 30 省公告栏目（统一栏目文件名，仅 abbr/code 不同；广东走 gd_pw 二期）
ANN_CMCC_PROVINCES = {
    "北京": "bj/100", "天津": "tj/220", "河北": "he/311", "山西": "sx/351",
    "内蒙古": "nm/471", "辽宁": "ln/240", "吉林": "jl/431", "黑龙江": "hl/451",
    "上海": "sh/210", "江苏": "js/250", "浙江": "zj/571", "安徽": "ah/551",
    "福建": "fj/591", "江西": "jx/791", "山东": "sd/531", "河南": "ha/371",
    "湖北": "hb/270", "湖南": "hn/731", "广西": "gx/771", "海南": "hi/898",
    "重庆": "cq/230", "四川": "sc/280", "贵州": "gz/851", "云南": "yn/871",
    "西藏": "xz/891", "陕西": "sn/290", "甘肃": "gs/931", "青海": "qh/971",
    "宁夏": "nx/951", "新疆": "xj/991",
}
ANN_CMCC_LIST_TPL = "https://www.10086.cn/aboutus/news/pannounce/%s/5004505_873_2361.json"

# 联通 31 省 code → 省名（2026-10-10 creatorProvinceName 直读钉死；031=上海 非湖南）
ANN_CUCC_CODES = {
    "010": "内蒙古", "011": "北京", "013": "天津", "017": "山东", "018": "河北",
    "019": "山西", "030": "安徽", "031": "上海", "034": "江苏", "036": "浙江",
    "038": "福建", "050": "海南", "051": "广东", "059": "广西", "070": "青海",
    "071": "湖北", "074": "湖南", "075": "江西", "076": "河南", "079": "西藏",
    "081": "四川", "083": "重庆", "084": "陕西", "085": "贵州", "086": "云南",
    "087": "甘肃", "088": "宁夏", "089": "新疆", "090": "吉林", "091": "辽宁",
    "097": "黑龙江",
}
ANN_CUCC_LIST_URL = "https://www.10010.com/mall/service/query/announcementquery"
ANN_CUCC_DETAIL_URL = "https://www.10010.com/mall/service/query/announcementquerydetail"
ANN_CUCC_PAGE_URL = ("https://www.10010.com/wt_links/index.html#/announcementDetail"
                     "?announcementId={id}&pageSize=12&pageNo=1")
ANN_CUCC_IMG_HOST = "https://m1.img.10010.com"
ANN_CUCC_HDRS = {
    "User-Agent": _ANN_UA,
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Referer": "https://www.10010.com/wt_links/index.html",
    "Origin": "https://www.10010.com",
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

# 电信 31 省 provCode（2026-10-10 逐省实测：接口严格按省返回不同内容）
ANN_CTCC_PROVINCES = {
    "北京": "609001", "天津": "609902", "河北": "609906", "山西": "609907",
    "内蒙古": "609908", "辽宁": "609905", "吉林": "609909", "黑龙江": "609910",
    "上海": "600102", "江苏": "600103", "浙江": "600104", "安徽": "600301",
    "福建": "600105", "江西": "600305", "山东": "609903", "河南": "609904",
    "湖北": "600202", "湖南": "600203", "广东": "600101", "广西": "600302",
    "海南": "600403", "重庆": "600304", "四川": "600201", "贵州": "600402",
    "云南": "600205", "西藏": "600406", "陕西": "600204", "甘肃": "600401",
    "青海": "600405", "宁夏": "600404", "新疆": "600303",
}
ANN_CTCC_REC_URL = "https://www.189.cn/wtBusiness/wtservice/nc/recPos/getRecPosInfo.do"
ANN_CTCC_DETAIL_URL = "https://www.189.cn/wtBusiness/wtservice/nc/announcement/getAnnouncementDetail.do"
ANN_CTCC_SITE = "https://www.189.cn"
ANN_CTCC_SHOP_ID = "20001"
ANN_CTCC_BASE_TYPE = "wt_sy_bzzx"   # 详情必须用条目自身 type（部分条目挂集团位 wt_sy_jtgg）
ANN_CTCC_FCODE = "Y121043001"
ANN_CTCC_PAGE_URL = "https://www.189.cn/web/notice"
ANN_CTCC_PUBKEY_B64 = (
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmUa6oMSBZrhfOjXCaYYIE9Lvj+r8nBIv"
    "CpydQmeG5CbeK5Qlwor+kFCrrPtcoYSowuUCB7YYsLYF6HVvf3Utw9FdLq7T8uNnfz2wxvp3N3Mi"
    "f5Rbhs7skrMvfy83zl7g9a1Xgz4OxmYbrm70E08F4Hu5K+86x9Qo+k8hSnJ4mkfb/fFL1/Im1n+i"
    "p2dBJ+vZt6mq8GykuAxQm4pb1UZw37HtdSR3WnU9Li0gDvXdJ87DAP0r7xF2DfTAQiAKP+3mdwlb"
    "KZ8hM0W7Do/7w+fBaOi+GCFJKvNDNVuH7G1OaEUuQH1xr3hoYAgqMdKOZWlZH+wbNqyAOxPL9V5K"
    "LF/30wIDAQAB"
)

# 广电（全网单源 ZZZZ；服务端忽略省份/类型参数，实测 8 组同结果）
ANN_CBN_URL = "https://m.10099.com.cn/contact-web/api/busi/queryAnnouncementInfoList"
ANN_CBN_PAGE_URL = "https://m.10099.com.cn/noticeList/"
ANN_CBN_PUBKEY_B64 = (
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4QJmWsYFtBbd/yoySbBAy7pBbfrgHr2SGSOGoBukd65IUqQ9uWhvzCN9r0nWESIXWW6FR2A5adHUFFeETucXGjU61BZxbLLf0ARL4F1NkkFMUF/D3GMY401+6TK8jVMxy4vLb6EKzlyZaI8jKBJ9jh0HMli6U7JHydsXstGRUnyx8Mu11bJ3+ZMUcKe51Zi+85Ez756EdZhGTXSY7pUAvh8/0Fea6mtsOs9OLMHbGMKAOE0alN1QdfqE3QMKgB58MVwlPY7uljelSocjNxCIS58CLvu1iWFrLvsCp8t3DavyA1OD/PPcXRrNLYZgzG5304/LAqfurOpU35AaB5tOnwIDAQAB"
)

# 广电必须用移动端 UA（桌面 UA + 裸 Referer 会被 H5 网关判"请求参数异常"）
_ANN_CBN_UA = ("Mozilla/5.0 (Linux; Android 9) AppleWebKit/537.36 "
               "Chrome/91 Mobile Safari/537.36;CBN")

ANN_LIMITS_DEFAULT = {
    # ── 公告保留天数：按运营商独立（广播广电等单源低频运营商可单独放宽窗口） ──
    #   过期条目写盘前丢弃；date 为空/解析不出的条目同样视为过期丢弃
    "retention_days_cmcc": 90,
    "retention_days_ctcc": 90,
    "retention_days_cucc": 90,
    "retention_days_cbn": 90,
    # ── 每源保留的最新条数：各运营商源架构不同，同名配置语义不同，故按运营商独立 ──
    #   cmcc 移动：30 省各自独立列表页（静态 JSON 文件直读）→ 逐省截断后合并跨省去重入库
    #   ctcc 电信：31 省各自独立列表页（province 参数逐省接口）→ 逐省截断后合并跨省去重入库
    #   cucc 联通：31 省共用一个 POST 混合源（province 参数区分省）→ 合并跨省去重后【整体】截断
    #              ⚠ cucc 的 N 是"31 省合计保留条数"，与 cmcc/ctcc 的"每省 N 条"完全不同量纲，
    #                值太小会把绝大多数省级公告截掉（实测 15 条时仅剩最近几天的全国性公告）
    #   cbn  广电：全网单源（服务端忽略省份/类型参数，8 组同结果）→ 整体截断
    "per_source_fetch_cmcc": 15,      # 移动：每省保留最新 N 条
    "per_source_fetch_ctcc": 15,      # 电信：每省保留最新 N 条
    "per_source_fetch_cucc": 200,     # 联通：31 省合并去重后的整体保留条数（混合源）
    "per_source_fetch_cbn": 15,       # 广电：全网单源整体保留 N 条
    "content_max": 20 * 1024,    # 单条正文 ≤20KB
    "file_max_bytes": 512 * 1024,  # 单文件兜底
    "national_threshold": 5,     # 联通混合源：出现在 ≥N 省判为全国
    "timeout_s": 20,
    "retries": 2,
    "sleep_s": 0.4,              # 源内限速
}


def _ann_limit(lim, carrier):
    """per_source_fetch 按运营商独立取值（配置键 per_source_fetch_<carrier>，缺省回退 15）"""
    try:
        return max(1, int(lim.get("per_source_fetch_%s" % carrier)))
    except (TypeError, ValueError):
        return 15


def _ann_retention(lim, carrier):
    """retention_days 按运营商独立取值（配置键 retention_days_<carrier>，缺省回退 90）"""
    try:
        return max(1, int(lim.get("retention_days_%s" % carrier)))
    except (TypeError, ValueError):
        return 90

ANN_KEEP_TAGS_RE = (r"(?!/?(p|br|div|a|img|strong|b|em|i|u|ul|ol|li|table|tr|td|th|"
                    r"tbody|thead|h\d|blockquote)(\s|/|>))")


def _ann_ssl_ctx():
    """移动源站 TLS 为旧版重协商，新版 OpenSSL 默认拒绝——显式开启兼容（参考项目同款，实测可直连，
    无需 curl 子进程）"""
    import ssl
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        try:
            ctx.options |= ssl.OP_LEGACY_SERVER_CONNECT
        except Exception:
            pass
        return ctx
    except Exception:
        return None


_ANN_SSL_CTX = _ann_ssl_ctx()


def _ann_http_get(url, headers=None, timeout=20, retries=2):
    import urllib.request
    last = None
    for attempt in range(max(1, retries + 1)):
        try:
            req = urllib.request.Request(url, headers=headers or {"User-Agent": _ANN_UA})
            try:
                with urllib.request.urlopen(req, timeout=timeout, context=_ANN_SSL_CTX) as r:
                    raw = r.read()
                    if r.headers.get("Content-Encoding") == "gzip":
                        import gzip
                        raw = gzip.decompress(raw)
                    return raw.decode("utf-8", "replace")
            except TypeError:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return r.read().decode("utf-8", "replace")
        except Exception as e:
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise last


def _ann_http_post(url, payload, headers=None, timeout=20, retries=2, is_json=False):
    import urllib.request, urllib.parse
    data = (payload if isinstance(payload, bytes) else
            (json.dumps(payload, separators=(",", ":")).encode()
             if is_json else urllib.parse.urlencode(payload).encode()))
    hdrs = {"User-Agent": _ANN_UA}
    hdrs.update(headers or {})
    last = None
    for attempt in range(max(1, retries + 1)):
        try:
            req = urllib.request.Request(url, data=data, method="POST", headers=hdrs)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    import gzip
                    raw = gzip.decompress(raw)
                return raw.decode("utf-8", "replace")
        except Exception as e:
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise last


def _ann_strip_style(html):
    """去 mso-*/font-* 内联样式，保留 color/background/排版值"""
    def _fix(m):
        keep = []
        for kv in re.findall(r'([\w-]+)\s*:\s*([^;]+);?', m.group(1)):
            k, v = kv[0].strip().lower(), kv[1].strip()
            if not k or not v:
                continue
            if k in ("color", "vertical-align", "text-align", "background-color"):
                keep.append("%s:%s" % (k, v))
            elif k.startswith("background") and len(v) > 4:
                keep.append("%s:%s" % (k, v))
        return ' style="%s"' % ";".join(keep) if keep else ""
    return re.sub(r'\sstyle="([^"]*)"', _fix, html)


def _ann_safe_proto(url):
    """协议白名单：http/https/mailto/相对链接，其余（javascript:/data: 等）置空"""
    if not url:
        return ""
    u = str(url).strip()
    if u.startswith(("/", "#", "./", "../")):
        return u
    low = u.lower()
    for ok in ("http://", "https://", "mailto:"):
        if low.startswith(ok):
            return u
    return ""


def _ann_abs_link(path, base):
    if not path or path.startswith(("http://", "https://", "data:")):
        return path
    if path.startswith("/"):
        return base + path
    return path


def _ann_clean_html(raw, base):
    """清洗公告富文本：剥脚本/样式/事件属性，白名单标签，协议白名单，相对链接补全"""
    import html as _htmlmod
    if not raw:
        return ""
    h = raw
    h = re.sub(r"<\?xml.*?\?>", "", h, flags=re.S)
    h = re.sub(r"<style.*?</style>", "", h, flags=re.S | re.I)
    h = re.sub(r"<script.*?</script>", "", h, flags=re.S | re.I)
    h = re.sub(r"<!--.*?-->", "", h, flags=re.S)
    h = re.sub(r"<" + ANN_KEEP_TAGS_RE + r"[^>]*>", "", h, flags=re.I)
    h = _ann_strip_style(h)
    h = re.sub(r'\s+(class|id|lang|dir|colspan|rowspan|border|width|height|align|'
               r'cellpadding|cellspacing|onclick|onload|onmouseover)="[^"]*"', "", h, flags=re.I)
    h = re.sub(r'(<img[^>]*?src=)["\'](?!https?://|data:)([^"\']*)["\']',
               lambda m: m.group(1) + '"' + _ann_abs_link(m.group(2), base) + '"', h, flags=re.I)
    h = re.sub(r'(<a[^>]*?href=)["\'](?!https?://|#|mailto:)([^"\']*)["\']',
               lambda m: m.group(1) + '"' + _ann_abs_link(m.group(2), base) + '"', h, flags=re.I)
    h = h.replace("</p>", "</p>\n").replace("<br>", "<br>\n")
    h = h.replace("<br/>", "<br>\n").replace("<br />", "<br>\n")
    h = re.sub(r"\n{3,}", "\n\n", h)
    h = re.sub(r'(<a[^>]*?href=)["\']([^"\']*)["\']',
               lambda m: m.group(1) + '"' + _ann_safe_proto(m.group(2)) + '"', h, flags=re.I)
    h = re.sub(r'(<img[^>]*?src=)["\']([^"\']*)["\']',
               lambda m: m.group(1) + '"' + _ann_safe_proto(m.group(2)) + '"', h, flags=re.I)
    return h.strip()


def _ann_html_to_text(h):
    import html as _htmlmod
    t = re.sub(r"<br\s*/?>", "\n", h, flags=re.I)
    t = re.sub(r"</(p|div|tr|li|h\d)>", "\n", t, flags=re.I)
    t = re.sub(r"<[^>]+>", "", t)
    t = _htmlmod.unescape(t)
    return re.sub(r"\s+", " ", t).strip()


def _ann_find_attachments(content_html, site):
    """从正文提取附件链接"""
    out = []
    for m in re.finditer(r'<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', content_html, flags=re.S | re.I):
        href, name_raw = m.group(1), m.group(2)
        if "/uploadBaseDir/" in href or re.search(
                r"\.(xlsx?|pdf|docx?|zip|rar|png|jpg|jpeg)(\?|$)", href, flags=re.I):
            name = _ann_html_to_text(name_raw).strip() or os.path.basename(href.split("?")[0]) or "附件"
            link = href if href.startswith("http") else (site + href)
            if link not in [a["url"] for a in out]:
                out.append({"name": name[:60], "url": link})
    return out


def _ann_date(s):
    """20260918145157 / 2026-09-18 12:00 / 2026年9月18日 → 2026-09-18（尽力归一）"""
    t = str(s or "").strip()
    m = re.search(r"(\d{4})[年\-/\.]?(\d{1,2})[月\-/\.]?(\d{1,2})", t)
    if m:
        return "%s-%02d-%02d" % (m.group(1), int(m.group(2)), int(m.group(3)))
    return t[:10]


def _ann_mkitem(carrier, src, iid, title, date, province, scope, page_url,
                content="", base="", seen=None):
    """构造统一条目（含清洗/摘要/附件/20KB 截断）"""
    lim = ANN_LIMITS_DEFAULT
    content = (content or "")[: lim["content_max"]]
    if content and len(content) >= lim["content_max"]:
        content += "…"
    return {
        "id": "%s:%s:%s" % (carrier, src, iid),
        "scope": scope,
        "province": "" if scope == "national" else (province or ""),
        "title": (title or "").strip(),
        "date": _ann_date(date),
        "pageUrl": page_url or "",
        "summary": _ann_html_to_text(content)[:200],
        "content": content,
        "attachments": _ann_find_attachments(content, base) if content else [],
        "seenIn": sorted(seen) if seen else None,
    }


def _ann_load_config(config):
    """TARIFF_CONFIG.announce 覆盖内置默认值；缺省/缺键 → 全内置默认（前向兼容）"""
    ann = {}
    try:
        ann = dict((config or {}).get("announce") or {})
    except Exception:
        ann = {}
    limits = dict(ANN_LIMITS_DEFAULT)
    for k in limits:
        if k in ann:
            try:
                limits[k] = type(limits[k])(ann[k])
            except Exception:
                pass
    sources_cfg = ann.get("sources")
    if not isinstance(sources_cfg, dict):
        sources_cfg = {}
    return {
        "enabled": bool(ann.get("enabled", True)),
        "limits": limits,
        "sources": {k: dict(v or {}) for k, v in sources_cfg.items()},
    }


def _ann_src_enabled(ann_cfg, key, default=True):
    src = ann_cfg["sources"].get(key)
    if src is None:
        return default
    return bool(src.get("enabled", default))


# ---------------- 移动（30 省，静态 JSON；广东走 gd_pw 二期） ----------------
def _ann_cmcc(ann_cfg):
    lim = ann_cfg["limits"]
    sources, items = {}, []
    for prov, path in ANN_CMCC_PROVINCES.items():
        list_url = ANN_CMCC_LIST_TPL % path
        try:
            j = json.loads(_ann_http_get(list_url, timeout=lim["timeout_s"],
                                         retries=lim["retries"]))
            lst = (j.get("cData") or {}).get("list") or []
        except Exception as e:
            sources[prov] = {"ok": False, "err": str(e)[:80]}
            logger.warning("[announce][cmcc] %s 列表失败: %s" % (prov, str(e)[:80]))
            continue
        rows = []
        for row in lst:
            m = re.search(r"_detail_(\d+)\.", row.get("detail_href") or "")
            if m:
                rows.append({"id": m.group(1), "title": row.get("noticeTitle") or "",
                             "date": row.get("publishTime") or ""})
        rows.sort(key=lambda x: x["date"], reverse=True)
        rows = rows[: _ann_limit(lim, "cmcc")]
        # 详情 URL = list 同目录 + 文件名干 + _detail_{id}.json
        dir_url = list_url.rsplit("/", 1)[0]
        stem = list_url.rsplit("/", 1)[1][:-5]
        ok_cnt = 0
        for row in rows:
            try:
                dj = json.loads(_ann_http_get(
                    "%s/%s_detail_%s.json" % (dir_url, stem, row["id"]),
                    timeout=lim["timeout_s"], retries=lim["retries"]))
                c = (dj.get("cData") or {}).get("content") or {}
                content = _ann_clean_html(c.get("text") or "", "https://www.10086.cn")
            except Exception as e:
                content = ""
            items.append(_ann_mkitem("cmcc", path.replace("/", "_"), row["id"],
                                     row["title"], row["date"], prov, "provincial",
                                     "https://www.10086.cn/aboutus/news/pannounce/%s/index_%s_%s_detail_%s.html"
                                     % (path.split("/")[0], path.split("/")[1],
                                        path.split("/")[1], row["id"]),
                                     content=content, base="https://www.10086.cn"))
            ok_cnt += 1
            time.sleep(lim["sleep_s"])
        sources[prov] = {"ok": True, "count": len(rows), "fetched": ok_cnt}
        logger.info("[announce][cmcc] %s %d 条" % (prov, len(rows)))
    return items, sources


# ---------------- 联通（31 省 POST 混合源，creatorProvinceName 直读 + 频次法） ----------------
def _ann_cucc_clean_prov(name, fallback):
    t = str(name or "").strip()
    t = re.sub(r"^中国联通", "", t)
    t = re.sub(r"(省|市)?分公司$", "", t)
    return t if t in set(ANN_CUCC_CODES.values()) else fallback


def _ann_cucc(ann_cfg):
    lim = ann_cfg["limits"]
    sources, merged = {}, {}   # dedupe键 → {"item":…, "codes": set()}
    for code, prov in ANN_CUCC_CODES.items():
        # 翻页取全量（参考项目同款）：源站返回顺序≠时间序，且 totalCount 可能大于
        # 单页上限（实测 117 条时 pageSize=100 第 2 页还有 17 条）——只拉第 1 页会漏掉
        # 落在后面的新公告。pageSize 固定 100 减少页数，翻到 totalCount 为止（≤5 页兜底）。
        rows, total = [], None
        for pg in range(1, 6):
            try:
                raw = _ann_http_post(ANN_CUCC_LIST_URL,
                                     {"pageNo": str(pg), "pageSize": "100",
                                      "province": code, "condition": "0", "title": ""},
                                     headers=ANN_CUCC_HDRS, timeout=lim["timeout_s"],
                                     retries=lim["retries"])
                j = json.loads(raw)
            except Exception as e:
                if pg == 1:
                    sources[code] = {"ok": False, "err": str(e)[:80]}
                    logger.warning("[announce][cucc] %s(%s) 列表失败: %s" % (prov, code, str(e)[:80]))
                else:
                    # 后续页失败不报废：已抓到的页继续参与合并（部分数据优于全无）
                    logger.warning("[announce][cucc] %s(%s) 第 %d 页失败(用已抓 %d 条): %s"
                                   % (prov, code, pg, len(rows), str(e)[:80]))
                break
            one = j.get("result") or []
            if total is None:
                try:
                    total = int(j.get("totalCount")) if j.get("totalCount") is not None else None
                except (TypeError, ValueError):
                    total = None
            rows += one
            if not one or (total is not None and len(rows) >= total):
                break
            time.sleep(lim["sleep_s"])
        if not rows and total is None:
            continue   # 第 1 页即失败：sources 已标记 ok=False，跳过该省
        sources[code] = {"ok": True, "count": len(rows)}
        for row in rows:
            rid = str(row.get("id") or "")
            if not rid:
                continue
            title = (row.get("title") or "").strip()
            date = (row.get("publishTime") or "")[:10]
            # 跨省去重键：同公告各省 id 可能不同，用 title+date 归一
            key = hashlib.md5(("%s|%s" % (title, date)).encode()).hexdigest()[:12]
            real_prov = _ann_cucc_clean_prov(row.get("creatorProvinceName"), prov)
            ent = merged.get(key)
            if ent is None:
                merged[key] = {
                    "item": _ann_mkitem("cucc", code, rid, title, date, real_prov,
                                        "provincial", ANN_CUCC_PAGE_URL.format(id=rid),
                                        seen=[code]),
                    "codes": {code}, "rid": rid, "row": row,
                }
            else:
                ent["codes"].add(code)
        time.sleep(lim["sleep_s"])
    # 频次法：出现在 ≥N 省 → 全国；否则 provincial（province 直读 creatorProvinceName）
    items = []
    for ent in merged.values():
        it = ent["item"]
        it["seenIn"] = sorted(ent["codes"])
        if len(ent["codes"]) >= lim["national_threshold"]:
            it["scope"] = "national"
            it["province"] = ""
        items.append(it)
    items.sort(key=lambda x: x["date"], reverse=True)
    items = items[: _ann_limit(lim, "cucc")]
    # 详情正文（仅保留的条目；code 必须与 rid 同源——首个命中省，而非字典序最小省）
    for it in items:
        code = (it["id"].split(":")[1] if len((it["id"] or "").split(":")) > 2 else "074")
        try:
            dj = json.loads(_ann_http_post(
                ANN_CUCC_DETAIL_URL,
                {"announcementId": ent_rid(it), "pageSize": "12", "pageNo": "1",
                 "province": code},
                headers=ANN_CUCC_HDRS, timeout=lim["timeout_s"], retries=lim["retries"]))
            n = dj.get("tNoticeDto") or {}
            content = _ann_clean_html(n.get("noticeDetails") or "", ANN_CUCC_IMG_HOST)
            content = re.sub(r'(<img[^>]*?src=)["\'](?!https?://)([^"\']*)["\']',
                             lambda m: m.group(1) + '"' + ANN_CUCC_IMG_HOST + m.group(2) + '"',
                             content, flags=re.I)
            if n.get("title"):
                it["title"] = n["title"].strip()
            if n.get("noticeTime"):
                it["date"] = n["noticeTime"][:10]
            it["content"] = content[: lim["content_max"]]
            it["summary"] = _ann_html_to_text(content)[:200]
            it["attachments"] = _ann_find_attachments(content, ANN_CUCC_IMG_HOST)
        except Exception as e:
            logger.warning("[announce][cucc] 详情 %s 失败: %s" % (it["id"], str(e)[:60]))
        time.sleep(lim["sleep_s"])
    return items, sources


def ent_rid(item):
    """从统一 id 反查联通原始公告 id（cucc:code:rid）"""
    parts = (item.get("id") or "").split(":")
    return parts[2] if len(parts) > 2 else ""


# ---------------- 电信（31 省 AES-CBC+RSA 信封；详情走 Playwright 通道） ----------------
def _ann_crypto():
    """兼容 pycryptodome(Crypto) / pycryptodomex(Cryptodome) 两种安装布局（本文件资费段用后者）"""
    try:
        from Cryptodome.Cipher import AES, PKCS1_v1_5
        from Cryptodome.PublicKey import RSA
        from Cryptodome.Util.Padding import pad
    except ImportError:
        from Crypto.Cipher import AES, PKCS1_v1_5
        from Crypto.PublicKey import RSA
        from Crypto.Util.Padding import pad
    return AES, PKCS1_v1_5, RSA, pad


def _ann_opener():
    """公告专用 opener：独立 CookieJar（与资费 requests 会话隔离）"""
    import http.cookiejar
    import urllib.request
    global _ANN_OPENER
    if _ANN_OPENER is None:
        _ANN_OPENER = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    return _ANN_OPENER


_ANN_OPENER = None


def _ann_ctcc_envelope(obj):
    """业务对象 → {param, key} 信封（AES-128-CBC 随机 key/iv + RSA 包装），返回 (payload, tid)"""
    import base64, random
    AES, PKCS1_v1_5, RSA, pad = _ann_crypto()
    pub = RSA.import_key(base64.b64decode(ANN_CTCC_PUBKEY_B64))
    key, iv = os.urandom(16), os.urandom(16)
    ct = AES.new(key, AES.MODE_CBC, iv).encrypt(
        pad(json.dumps(obj, ensure_ascii=False).encode(), 16))
    inner = json.dumps({"key": base64.b64encode(key).decode(),
                        "iv": base64.b64encode(iv).decode()}, separators=(",", ":"))
    payload = {"param": base64.b64encode(ct).decode(),
               "key": base64.b64encode(PKCS1_v1_5.new(pub).encrypt(inner.encode())).decode()}
    tid = "".join("%x" % random.randint(0, 15) for _ in range(32))
    return payload, tid


def _ann_ctcc_pw_details(tasks, page_wait_s=4):
    """电信详情 Playwright 通道（2026-10-11 实测：tariffZone 过盾 + 页面内同域 fetch）。

    tasks: [{key, offer, type, prov, prov_name, row}]
    打开资费专区 /tariffZone/ 一次（该入口瑞数挑战对自动化放行，与资费采集同款；
    公告页/静态详情页入口均被瑞数指纹拒绝），会话就绪后在**页面上下文内**逐条
    POST 详情接口（同域可信会话放行，单条约 0.5s）。
    返回 {key: 响应文本 or 'HTTP xxx' or 'ERR ...'}；启动失败抛异常，由调用方降级。
    """
    from playwright.sync_api import sync_playwright
    pw = browser = context = page = None
    out = {}
    try:
        pw = sync_playwright().start()
        launch_args = ['--disable-blink-features=AutomationControlled', '--no-sandbox',
                       '--disable-dev-shm-usage']
        # 系统级 chromium 优先（与资费 CtccApi._ensure_browser 同款扫描）；
        # 再扫 playwright 缓存目录——包升级后当前版本要求的 build 可能缺失，
        # 但历史安装的旧 build 二进制仍可直接 executable_path 指定使用
        import glob as _glob
        system_bins = []
        for _bin in (shutil.which('chromium'), shutil.which('chromium-browser'),
                     shutil.which('google-chrome'),
                     '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'):
            if _bin and os.path.exists(_bin) and _bin not in system_bins:
                system_bins.append(_bin)
        _pw_cache = os.path.expanduser('~/.cache/ms-playwright')
        for _pat in (os.path.join(_pw_cache, 'chromium-*', 'chrome-linux', 'chrome'),
                     os.path.join(_pw_cache, 'chromium_headless_shell-*', 'chrome-linux',
                                  'headless_shell')):
            for _p in sorted(_glob.glob(_pat), reverse=True):
                if os.path.exists(_p) and _p not in system_bins:
                    system_bins.append(_p)
        opts_list = [{'executable_path': b, 'headless': True, 'args': launch_args}
                     for b in system_bins]
        opts_list += [{'channel': 'msedge', 'headless': True, 'args': launch_args},
                      {'channel': 'chrome', 'headless': True, 'args': launch_args},
                      {'headless': True, 'args': launch_args}]
        browser = None
        last_err = None
        for opts in opts_list:
            try:
                browser = pw.chromium.launch(**opts)
                break
            except Exception as e:
                last_err = e
        if browser is None:
            raise RuntimeError('无法启动浏览器: %s' % last_err)
        # 与资费通道完全同款的伪装组合：UA(WinEdge153) + 全套 stealth 伪造
        # （WebGL/插件/chrome对象/Win32平台——headless 裸奔会被瑞数深层指纹识别，
        # 表现为白屏+全 400；资费实例带全套伪装所以能过）+ 时区对齐
        context = browser.new_context(
            user_agent=('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                        '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 '
                        'Edg/153.0.4234.32'),
            locale='zh-CN', timezone_id='Asia/Shanghai',
            viewport={'width': 1280, 'height': 800})
        context.add_init_script(_ctcc_stealth_script())
        page = context.new_page()

        # 过盾：入口=资费专区（实测瑞数挑战对自动化放行；公告页/静态页入口均被指纹拒绝）。
        # 抽成局部函数供"会话中途失效"时重过盾（连续失败触发，上限 3 次防死循环）
        def _pass_gate(reason):
            page.goto(ANN_CTCC_SITE + '/tariffZone/',
                      timeout=60000, wait_until='domcontentloaded')
            # 等瑞数动态 cookie（EYg4* 前缀，与资费采集同判定）
            for _ in range(10):
                time.sleep(3)
                if any(c['name'].startswith('EYg4') for c in context.cookies()):
                    break
            _diag = page.evaluate(
                "({ua: navigator.userAgent, tl: (document.body ? document.body.innerText.length : -1)})")
            logger.info('[announce][ctcc] tariffZone 会话就绪(%s)，页面内 fetch 详情 %d 条'
                        '（页面文本=%s, 内核=%s, UA=%s）'
                        % (reason, len(tasks), _diag.get("tl"), browser.version, _diag.get("ua")))

        _pass_gate('初始')
        # 过盾会话内同域 fetch 详情接口（瑞数为会话级校验，同域可信会话放行；
        # 加密信封与裸 HTTP 列表同款）。单条失败记录继续，不中断整批；
        # 连续 5 条非 200 判定会话失效 → 重过盾（≤3 次），失败条目由写盘继承兜底
        detail_url = (ANN_CTCC_SITE +
                      '/wtBusiness/wtservice/nc/announcement/getAnnouncementDetail.do')
        consec_pw_fail, regates = 0, 0
        for i, t in enumerate(tasks, 1):
            try:
                payload, _tid = _ann_ctcc_envelope({
                    "offerCode": t["offer"], "type": t["type"],
                    "provinceCode": t["prov"], "cityCode": "",
                })
                res = page.evaluate(
                    '''async (args) => {
                        const r = await fetch(args.url, {method: 'POST', body: args.body,
                            headers: {'Content-Type': 'application/json;charset=UTF-8',
                                      'Fcode': args.fcode}});
                        return {status: r.status, text: await r.text()};
                    }''',
                    {"url": detail_url,
                     "body": json.dumps(payload, separators=(",", ":")),
                     "fcode": ANN_CTCC_FCODE})
                if res.get("status") == 200:
                    out[t["key"]] = res.get("text") or ""
                    consec_pw_fail = 0
                else:
                    out[t["key"]] = ("HTTP %s %s"
                                     % (res.get("status"), (res.get("text") or "")[:150]))
                    consec_pw_fail += 1
            except Exception as e:
                out[t["key"]] = "ERR " + str(e)[:80]
                consec_pw_fail += 1
            if consec_pw_fail >= 5 and regates < 3:
                regates += 1
                consec_pw_fail = 0
                logger.warning('[announce][ctcc] PW 会话疑似失效（连续 5 条失败），第 %d 次重过盾' % regates)
                try:
                    _pass_gate('重过盾#%d' % regates)
                except Exception as e:
                    logger.warning('[announce][ctcc] 重过盾失败(继续原会话): %s' % str(e)[:80])
            if i % 25 == 0:
                logger.info('[announce][ctcc] 详情进度 %d/%d' % (i, len(tasks)))
            time.sleep(0.3)
        return out
    finally:
        for obj in (page, context, browser):
            if obj is not None:
                try:
                    obj.close()
                except Exception:
                    pass
        if pw is not None:
            try:
                pw.stop()
            except Exception:
                pass


def _ann_ctcc_post(obj, url=None, timeout=20, retries=2):
    import base64, gzip, random
    import urllib.request
    payload, tid = _ann_ctcc_envelope(obj)
    req = urllib.request.Request(
        url or ANN_CTCC_REC_URL, data=json.dumps(payload, separators=(",", ":")).encode(),
        method="POST",
        headers={"User-Agent": _ANN_UA, "Content-Type": "application/json;charset=UTF-8",
                 "Accept": "application/json, text/plain, */*",
                 "Origin": ANN_CTCC_SITE,
                 "Referer": ANN_CTCC_SITE + "/web/notice/index.html",
                 "Fcode": ANN_CTCC_FCODE, "TransactionId": tid,
                 "Accept-Language": "zh-CN,zh;q=0.9"})
    last = None
    for a in range(max(1, retries + 1)):
        try:
            # 列表+详情必须同一会话通道（同一 opener/cookie jar，混用 → 瑞数判会话不一致 → 412）
            with _ann_opener().open(req, timeout=timeout) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return json.loads(raw.decode("utf-8", "replace"))
        except Exception as e:
            last = e
            time.sleep(2 * (a + 1))
    raise last


_ANN_CTCC_DET_URL = ANN_CTCC_SITE + '/wtBusiness/wtservice/nc/announcement/getAnnouncementDetail.do'
_ANN_CTCC_DIRECT_SLEEP_S = 1.0   # 直连详情限速（参考项目防 WAF 实测 1.3s，按 342 条/轮取 1.0s 折中）


def _ann_ctcc_direct_details(prov_tasks):
    """电信详情直连通道——单省批次（借鉴资费采集两级模式：调用方逐省尝试直连，
    失败省收集后统一 PW 回退，而非开头探针定终身）。裸 HTTP POST 详情接口，
    加密信封与列表同款、同一 Cookie 会话（列表+详情混用会话 → 瑞数判会话不一致 → 412，
    与列表通道同约束）。返回 resp_map（值 = JSON 响应文本 or 'ERR ...'，与 PW 通道
    同构，阶段3 统一解析）；单条失败仅记录不中断，省内条目全败由调用方判定。"""
    out = {}
    for t in prov_tasks:
        try:
            r = _ann_ctcc_post(
                {"offerCode": t["offer"], "type": t["type"],
                 "provinceCode": t["prov"], "cityCode": ""},
                url=_ANN_CTCC_DET_URL, timeout=15, retries=1)
            out[t["key"]] = json.dumps(r, ensure_ascii=False) if isinstance(r, dict) else ""
        except Exception as e:
            out[t["key"]] = "ERR " + str(e)[:100]
        time.sleep(_ANN_CTCC_DIRECT_SLEEP_S)
    return out


def _ann_ctcc(ann_cfg):
    lim = ann_cfg["limits"]
    sources, items, per_prov = {}, [], {}
    # ── 阶段1：列表（裸 HTTP 信封，稳定可用） ──
    for prov, prov_code in ANN_CTCC_PROVINCES.items():
        try:
            r = _ann_ctcc_post({"shopId": ANN_CTCC_SHOP_ID, "type": ANN_CTCC_BASE_TYPE,
                                "order": 1, "provinceCode": prov_code, "cityCode": ""},
                               timeout=lim["timeout_s"], retries=lim["retries"])
            raw = []
            for d in (r.get("data") or []):
                for x in (d.get("floorItems") or []):
                    raw.append(x)
        except Exception as e:
            sources[prov] = {"ok": False, "err": str(e)[:80]}
            logger.warning("[announce][ctcc] %s(%s) 列表失败: %s" % (prov, prov_code, str(e)[:80]))
            continue
        if not raw:
            sources[prov] = {"ok": True, "count": 0}
            continue
        rows = []
        for x in raw:
            title = (x.get("title") or "").strip()
            if not title:
                continue
            rows.append({
                "id": str(x.get("externalOfferCode") or x.get("offerCode") or x.get("id") or ""),
                "title": title,
                "date": _ann_date(x.get("liveStartTime") or x.get("publishTime")
                                  or x.get("createTime") or ""),
                "_type": (x.get("type") or ANN_CTCC_BASE_TYPE),
            })
        rows.sort(key=lambda x: (x["date"], x["id"]), reverse=True)
        rows = rows[: _ann_limit(lim, "ctcc")]
        per_prov[prov] = (prov_code, rows)
        sources[prov] = {"ok": True, "count": len(rows), "fetched": 0}
        logger.info("[announce][ctcc] %s 列表 %d 条" % (prov, len(rows)))
    if not per_prov:
        return items, sources
    # ── 阶段2：详情（导航 SPA 详情页，捕获页面自身的 API 响应；失败降级空正文） ──
    tasks = []
    for prov, (prov_code, rows) in per_prov.items():
        for row in rows:
            tasks.append({"key": "%s|%s" % (prov, row["id"]), "offer": row["id"],
                          "type": row["_type"], "prov": prov_code,
                          "prov_name": prov, "row": row})
    # ── 阶段2：详情（借鉴电信资费采集两级模式：先逐省直连，失败省统一 PW 回退） ──
    # 瑞数拦截是会话/IP 级：一旦被拦后续省全挂，连续 3 省整省失败即熔断，
    # 剩余省不再逐个白试，直接进 PW 批（与资费采集 pw_needs_fallback 同思路）
    resp_map, pw_tasks = {}, []
    consec_fail, done_provs, direct_ok_provs = 0, set(), set()
    for prov, (prov_code, rows) in per_prov.items():
        prov_tasks = [t for t in tasks if t["prov"] == prov_code]
        try:
            sub = _ann_ctcc_direct_details(prov_tasks)
            if not any(v.startswith("{") for v in sub.values()):
                raise RuntimeError("该省直连全部无正文")
            consec_fail = 0
            direct_ok_provs.add(prov)
            resp_map.update(sub)
        except Exception as e:
            consec_fail += 1
            logger.warning("[announce][ctcc] %s 直连失败, 标记 PW 回退: %s" % (prov, str(e)[:80]))
            pw_tasks.extend(prov_tasks)
            if consec_fail >= 3:
                for p2, (pc2, _r2) in per_prov.items():
                    if p2 not in done_provs and p2 != prov:
                        pw_tasks.extend(t for t in tasks if t["prov"] == pc2)
                logger.warning("[announce][ctcc] 连续 %d 省直连全败（疑似全局被拦），剩余省全部转入 PW" % consec_fail)
                break
        done_provs.add(prov)
    if resp_map:
        logger.info("[announce][ctcc] 直连详情完成 %d 条（直连成功 %d/%d 省，PW 回退 %d 条）"
                    % (len(resp_map), len(direct_ok_provs), len(per_prov), len(pw_tasks)))
    if pw_tasks:
        logger.info("[announce][ctcc] PW 回退: %d 条详情走 Playwright（一次过盾）" % len(pw_tasks))
        try:
            resp_map.update(_ann_ctcc_pw_details(pw_tasks))
        except Exception as e:
            logger.warning("[announce][ctcc] PW 详情通道失败，这部分降级为无正文: %s" % str(e)[:120])
    # ── 阶段3：解析详情响应 → 统一条目 ──
    for t in tasks:
        key, prov, row = t["key"], t["prov_name"], t["row"]
        content = ""
        resp = resp_map.get(key) or ""
        if resp.startswith("{"):
            try:
                d = json.loads(resp)
                node = (d.get("data") or {}) if isinstance(d, dict) else {}
                raw_html = (node.get("content") or "").strip()
                if raw_html:
                    raw_html = re.sub(r'(<img[^>]*?src=)["\'](?!https?://|data:)([^"\']*)["\']',
                                      lambda m: m.group(1) + '"' + ANN_CTCC_SITE + m.group(2) + '"',
                                      raw_html, flags=re.I)
                    raw_html = re.sub(r'(<a[^>]*?href=)["\'](?!https?://|#|mailto:)([^"\']*)["\']',
                                      lambda m: m.group(1) + '"' + ANN_CTCC_SITE + m.group(2) + '"',
                                      raw_html, flags=re.I)
                    content = _ann_clean_html(raw_html, ANN_CTCC_SITE)
                    if node.get("title"):
                        row["title"] = node["title"].strip()
            except Exception as e:
                logger.warning("[announce][ctcc] %s 详情解析失败 %s: %s"
                               % (prov, row["id"], str(e)[:60]))
        elif resp:
            logger.warning("[announce][ctcc] %s 详情 %s: %s" % (prov, row["id"], resp[:40]))
        items.append(_ann_mkitem("ctcc", "prov", row["id"], row["title"], row["date"],
                                 prov, "provincial", ANN_CTCC_PAGE_URL,
                                 content=content, base=ANN_CTCC_SITE))
        if content:
            sources[prov]["fetched"] = sources[prov].get("fetched", 0) + 1
    return items, sources


# ---------------- 广电（全网单源；MD5 签名 + 244 字节分块 RSA 信封） ----------------
def _ann_cbn_post(obj, timeout=20, retries=2):
    import base64, gzip
    import urllib.request, urllib.parse, hashlib
    _, PKCS1_v1_5, RSA, _ = _ann_crypto()
    pub = RSA.import_key(base64.b64decode(ANN_CBN_PUBKEY_B64))
    # Access = MD5(键排序后 k=v 串，对象值 JSON 序列化，& 连接) hex 小写
    parts = []
    for k in sorted(obj.keys()):
        v = obj[k]
        parts.append("%s=%s" % (k, json.dumps(v, ensure_ascii=False, separators=(",", ":"))
                                if isinstance(v, (dict, list)) else v))
    access = hashlib.md5("&".join(parts).encode()).hexdigest()
    plain = urllib.parse.quote(json.dumps(obj, ensure_ascii=False), safe="").encode()
    hexed = "".join(PKCS1_v1_5.new(pub).encrypt(plain[i:i + 244]).hex()
                    for i in range(0, len(plain), 244))
    # 关键：hex 先还原成二进制再 base64（对齐官网 encryptLong——此前对 hex 字符串
    # 直接 base64，服务端解出 ASCII 文本致 RSA 解密失败 → "请求参数异常"）
    payload = {"data": base64.b64encode(bytes.fromhex(hexed)).decode()}
    req = urllib.request.Request(
        ANN_CBN_URL, data=json.dumps(payload, separators=(",", ":")).encode(), method="POST",
        headers={"User-Agent": _ANN_CBN_UA, "Access": access,
                 "Content-Type": "application/json",
                 "Origin": "https://m.10099.com.cn",
                 "Referer": "https://m.10099.com.cn/noticeList/pages/extensions/noticeList/index"})
    last = None
    for a in range(max(1, retries + 1)):
        try:
            with _ann_opener().open(req, timeout=timeout) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return json.loads(raw.decode("utf-8", "replace"))
        except Exception as e:
            last = e
            time.sleep(2 * (a + 1))
    raise last


def _ann_cbn(ann_cfg):
    lim = ann_cfg["limits"]
    items = []
    # 成功组合（2026-10-10 PC 实测）：provinceCode=ZZZZ + 移动端 UA + SPA 完整 Referer
    # 三者缺一会被 H5 网关判"请求参数异常"（000001）
    r = _ann_cbn_post({"provinceCode": "ZZZZ"}, timeout=lim["timeout_s"],
                      retries=lim["retries"])
    rows = r.get("data") or []
    if not rows:
        # 诊断：响应结构与预期不符时打印关键信息，便于定位（信封错/风控页/字段变更）
        logger.warning("[announce][cbn] 响应 0 条：status=%s keys=%s body=%s"
                       % (r.get("status"), list(r.keys())[:6],
                          json.dumps(r, ensure_ascii=False)[:200]))
    rows.sort(key=lambda x: str(x.get("startTime") or x.get("publishTime") or ""),
              reverse=True)
    raw_n = len(rows)
    rows = rows[: _ann_limit(lim, "cbn")]
    logger.info("[announce][cbn] 源返回 %d 条，截断后 %d 条（保留窗口 %d 天）"
                % (raw_n, len(rows), _ann_retention(lim, "cbn")))
    for x in rows:
        iid = str(x.get("id") or x.get("infoId") or "")
        title = (x.get("title") or "").strip()
        if not title:
            continue
        content = _ann_clean_html(x.get("messageInfo") or "", "https://m.10099.com.cn")
        items.append(_ann_mkitem("cbn", "all", iid or _ann_date(x.get("startTime")),
                                 title, x.get("startTime") or x.get("publishTime") or "",
                                 "", "national",
                                 x.get("url") or x.get("link") or ANN_CBN_PAGE_URL,
                                 content=content, base="https://m.10099.com.cn"))
        time.sleep(lim["sleep_s"])
    return items, {"ZZZZ": {"ok": True, "count": len(items)}}


# ---------------- 广东（独立省站 + WAF，复用电信资费 Playwright 基建） ----------------
def _ann_cmcc_gd(ann_cfg):
    """二期灰度：无头浏览器过盾 → 解析 /whatsnew/notice/list/2_{city}.shtml + detail SSR。
    详见 spec §3.2；enabled=false 时直接跳过。"""
    return [], {"gd": {"ok": True, "skipped": "二期灰度（spec §3.2）"}}


# ---------------- 调度器 ----------------
def fetch_announcements(config, storage):
    """主流程尾部调用：四源独立 try，产出 4 × data/{carrier}/announce.json。
    抓空且全源失败 → 跳过该 carrier 写盘（防源站抖动清空线上公告）。
    返回公告新增清单 {carrier: [ {carrier,id,title,date,province} ]}（采集播报用，
    首轮建基线/无新增/未启用 → 空对象）。"""
    announce_new = {}
    ann_cfg = _ann_load_config(config)
    if not ann_cfg["enabled"]:
        logger.info("[announce] 公告采集未启用（TARIFF_CONFIG.announce.enabled=false），跳过")
        return announce_new
    lim = ann_cfg["limits"]
    jobs = [
        ("cmcc", _ann_cmcc, True),
        ("cucc", _ann_cucc, True),
        ("ctcc", _ann_ctcc, True),
        ("cbn", _ann_cbn, True),
    ]
    t0 = time.time()
    total = 0
    # 开关键名必须传运营商键 c（此前误传布尔 on → sources 配置永远查不到 → 四源全开）
    active_jobs = [(c, fn) for c, fn, on in jobs if _ann_src_enabled(ann_cfg, c)]
    skipped = [c for c, fn, on in jobs if not _ann_src_enabled(ann_cfg, c)]
    for c in skipped:
        logger.info("[announce] %s 源未启用，跳过" % c)

    def _ann_worker(carrier, fn):
        # 线程内设置日志运营商标识（threading.local 不跨线程）
        _carrier_ctx.carrier = CARRIER_DISPLAY_NAMES.get(carrier, carrier)
        try:
            items, sources = fn(ann_cfg)
            return (carrier, items, sources, None)
        except Exception as e:
            logger.warning("[announce] %s 源整体失败(不影响其他源): %s" % (carrier, str(e)[:100]))
            return (carrier, [], {}, e)

    # 四源并行抓取（各自独立 HTTP/PW 会话；storage 写盘留在主线程，规避并发写）
    results = {}
    if active_jobs:
        from concurrent.futures import ThreadPoolExecutor, as_completed
        with ThreadPoolExecutor(max_workers=min(4, len(active_jobs))) as executor:
            futs = {executor.submit(_ann_worker, c, fn): c for c, fn in active_jobs}
            for f in as_completed(futs):
                carrier, items, sources, err = f.result()
                results[carrier] = (items, sources, err)

    for carrier, fn, default_on in jobs:
        if carrier not in results:
            continue
        items, sources, err = results[carrier]
        if err is not None:
            continue
        _carrier_ctx.carrier = CARRIER_DISPLAY_NAMES.get(carrier, carrier)
        ok_sources = [k for k, v in sources.items() if v.get("ok")]
        if not items:
            # 「0 条绝不落盘」：源站改版/抖动返回空列表时不覆盖线上旧公告
            logger.warning("[announce] %s 本轮 0 条（源 ok=%d/%d），跳过写盘保持线上不变"
                           % (carrier, len(ok_sources), len(sources)))
            continue
        # retention：按日期保留（date YYYY-MM-DD 字符串比较）；窗口按运营商独立（_ann_retention）
        cutoff = (datetime.date.today() - datetime.timedelta(days=_ann_retention(lim, carrier))).isoformat()
        kept = [it for it in items if (it.get("date") or "") >= cutoff]
        kept.sort(key=lambda x: (x.get("date") or ""), reverse=True)
        if len(kept) < len(items):
            logger.info("[announce] %s retention(%d 天) 过滤：%d → %d 条" % (carrier, _ann_retention(lim, carrier), len(items), len(kept)))
        # 字段级正文继承（参考项目 merge_keep 同语义）：本轮详情失败的条目（content 空）
        # 沿用上轮成功内容，绝不回退成空。上轮数据来源由 storage.read_json 决定：
        # local_cache 开启读本地副本（零网络开销），未开启读线上；只补
        # content/summary/attachments 三个详情衍生字段，其余字段如实反映本轮。
        old_by_id = {}
        try:
            _old = storage.read_json("%s/announce.json" % carrier)
            if isinstance(_old, dict) and isinstance(_old.get("items"), list):
                old_by_id = {str(o.get("id") or ""): o for o in _old["items"] if o.get("id")}
        except Exception as e:
            logger.warning("[announce] %s 读取上轮公告失败(本轮跳过继承): %s" % (carrier, str(e)[:60]))
        inherited = 0
        for it in kept:
            if (it.get("content") or "").strip():
                continue
            o = old_by_id.get(str(it.get("id") or ""))
            if o and (o.get("content") or "").strip():
                it["content"] = o["content"]
                it["summary"] = o.get("summary") or it.get("summary", "")
                it["attachments"] = o.get("attachments") or it.get("attachments", [])
                inherited += 1
        if inherited:
            logger.info("[announce] %s 继承上轮正文 %d 条（本轮详情接口部分失败）" % (carrier, inherited))
        # 采集播报：对比旧公告找新增（按 运营商+公告id 判新增；只看新增，公告无下架概念）。
        # 首轮/旧文件缺失（old_by_id 空）→ 只建基线不产出，防存量爆量；
        # 单运营商单轮截断 10 条（分发端超出部分显示"等 N 条"）。
        new_items = [it for it in kept if str(it.get("id") or "") not in old_by_id]
        if old_by_id and new_items:
            trimmed = new_items[:10]
            announce_new[carrier] = [
                {"carrier": carrier, "id": str(it.get("id") or ""),
                 "title": (it.get("title") or "")[:120], "date": it.get("date") or "",
                 "province": it.get("province") or ""}
                for it in trimmed
            ]
            extra = len(new_items) - len(trimmed)
            logger.info("[announce] %s 新增公告 %d 条（播报收录 %d 条%s）"
                        % (carrier, len(new_items), len(trimmed), ("，截断 %d 条" % extra) if extra > 0 else ""))
        elif not old_by_id:
            logger.info("[announce] %s 首轮建立公告基线（%d 条），本轮不推送新增" % (carrier, len(kept)))
        payload = {
            "v": 1,
            "carrier": carrier,
            "updated": int(time.time() * 1000),
            "ok": True,
            "sources": sources,
            "items": kept,
        }
        # 文件兜底 ≤512KB：超限丢最旧
        while len(json.dumps(payload, ensure_ascii=False).encode()) > lim["file_max_bytes"] and kept:
            kept.pop()
            payload["items"] = kept
        try:
            storage.write_json("%s/announce.json" % carrier, payload)
            total += len(kept)
            logger.info("[announce] %s 写盘 %d 条（源 %d/%d ok，耗时 %.0fs）"
                        % (carrier, len(kept), len(ok_sources), len(sources),
                           time.time() - t0))
        except Exception as e:
            logger.warning("[announce] %s 写盘失败: %s" % (carrier, str(e)[:80]))
    logger.info("[announce] 公告采集完成，共 %d 条，总耗时 %.0fs" % (total, time.time() - t0))
    _carrier_ctx.carrier = '系统'   # 清理上下文，避免后续部署日志误挂运营商名
    return announce_new


if __name__ == '__main__':
    try:
        run()
    except Exception as e:
        logger.error(f'致命错误: {e}')
        logger.error(traceback.format_exc())
        try:
            send_notification('资费监控-致命错误', str(e))
        except Exception:
            pass
        for _api in _active_apis:
            if hasattr(_api, 'close'):
                try:
                    _api.close()
                except Exception:
                    pass
        sys.exit(1)