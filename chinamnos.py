"""
中国移动资费自动监控系统 - 青龙单文件版
Python v2.1.0

运行在青龙面板，由 cron 触发。
产出符合 data-schema-v2 的 snapshot / changelog / stats。

依赖: requests, pycryptodomex
环境变量: TARIFF_CONFIG (JSON 格式完整配置)

用法:
  python CMCC.py                  # 正常采集
  python CMCC.py --init           # 初始化基线（不通知）
  python CMCC.py --test           # 测试模式（仅切换日志级别为 DEBUG，采集范围由配置决定）
  python CMCC.py --rebuild-stats  # 从已有快照重建 stats（不采集，适合改了 stats 结构时）
  python CMCC.py --deploy-frontend  # 仅部署前端文件（不采集、不重建 stats）
"""

import os
import sys
import json
import re
import shutil
import time
import random
import logging
import threading
import datetime
import traceback
import ssl
import uuid
import base64
import hashlib
import mimetypes
import string
from urllib.parse import urlparse
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
        'type': 'cloudflare',
        'cloudflare': {
            'account_id': '',
            'project_name': '',
            'api_token': '',
            'domain': '',
            'path': 'data',
            'include_frontend': True,
            'frontend_dir': './pages-dist',
        },
        'github': {
            'token': '',
            'repo': '',
            'branch': 'main',
            'path': 'data',
            'domain': '',
            'include_frontend': True,
            'frontend_dir': './pages-dist',
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
    errors = []

    storage_type = config['storage']['type']
    if storage_type not in ('cloudflare', 'github'):
        errors.append(f'storage.type 无效: {storage_type}, 可选: cloudflare/github')

    if storage_type == 'cloudflare':
        cf = config['storage']['cloudflare']
        for k in ('account_id', 'project_name', 'api_token'):
            if not cf.get(k):
                errors.append(f'storage.cloudflare.{k} 未配置')
        if not cf.get('domain'):
            errors.append('storage.cloudflare.domain 未配置（Cloudflare 方案必须配置域名，否则无法读取旧数据做对比）')
    elif storage_type == 'github':
        gh = config['storage']['github']
        if not gh.get('token'):
            errors.append('storage.github.token 未配置')
        if not gh.get('repo'):
            errors.append('storage.github.repo 未配置')

    cache_ttl = config.get('storage', {}).get('cache', {}).get('ttl_minutes', 30)
    if not isinstance(cache_ttl, (int, float)) or cache_ttl < 0:
        errors.append('storage.cache.ttl_minutes 需为非负数')

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
        ('retry_max_ms', 1000, 120000),
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
            ('retry_max_ms', 1000, 120000),
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
                return None
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

        try:
            three_result = self._post('/queryTariffNew/threeLevelName', {
                'provinceId': cucc_prov,
                'cityId': cucc_city,
                'tariffAttributes': int(tariff_attr) if str(tariff_attr) in ('1', '2') else 1,
                'firstLevel': _cucc_first or '1',
                'secondLevel': _cucc_second or '1001',
            })
        except Exception as e:
            logger.warning(f'  联通 threeLevelName 失败: {e}')
            return {'data': {'beans': []}}

        if not three_result or three_result.get('code') != '0000':
            return {'data': {'beans': []}}

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
            try:
                detail = self._post(f'/queryTariffNew/operateData/{joined_ids}', {
                    'provinceId': cucc_prov,
                    'cityId': cucc_city,
                    'page': page,
                    'size': limit,
                })
            except Exception as e:
                logger.warning(f'  联通 operateData 批量失败 (batch={i//batch_size + 1}): {e}')
                continue

            if not detail or detail.get('code') != '0000':
                continue

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
        try:
            result = self._fetch_with_retry('newTarifZone3Title.do', {
                'provCode': ctcc_prov,
                'lable1Id': _ctcc_lable1Id,
                'page': page,
                'limit': limit,
            }, retry_times=retry_times, retry_base_ms=retry_base_ms,
               retry_max_ms=retry_max_ms, retry_jitter=retry_jitter)
        except Exception as e:
            logger.warning(f'  电信 newTarifZone3Title 失败: {e}')
            return {'data': {'beans': []}}

        if not result or str(result.get('code')) != '0':
            return {'data': {'beans': []}}

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

        try:
            result = self._post('/goods/queryTariffAllByCond', {
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
            })
        except Exception as e:
            logger.warning(f'  广电 queryTariffAllByCond 失败: {e}')
            return {'data': {'beans': []}}

        if not result or not result.get('ok'):
            return {'data': {'beans': []}}

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
    if not f['短信']:
        _m = re.search(r'短信\s*(\d+)\s*条', f.get('其他服务内容', '') or '')
        if _m:
            f['短信'] = f'{_m.group(1)}条'
    f['亲情网'] = _s(nm.get('familyNet'))
    f['权益'] = _s(nm.get('rights'))
    f['超出资费说明'] = _s(nm.get('extraFees'))
    f['额外费用'] = _s(nm.get('extraFee'))
    f['其他费用'] = _s(nm.get('otherFee'))
    f['资费说明'] = _s(nm.get('tariffDesc') or nm.get('feeDesc'))
    f['其他服务内容'] = _s(nm.get('otherContent'))
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

def _collect_frontend_files(frontend_dir_path):
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
            json.dump(data, f, ensure_ascii=False, indent=2)
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
        fpath = os.path.join(self._local_cache_dir, 'deploy_manifest.json')
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
        fpath = os.path.join(self._local_cache_dir, 'deploy_manifest.json')
        os.makedirs(os.path.dirname(fpath), exist_ok=True)
        with open(fpath, 'w', encoding='utf-8') as f:
            json.dump({'version': 1, 'manifest': manifest}, f, ensure_ascii=False, indent=2)

    def read_json(self, key):
        raise NotImplementedError

    def write_json(self, key, data):
        raise NotImplementedError

    def list_keys(self, prefix=''):
        raise NotImplementedError

    def commit(self, message='auto update', skip_unchanged_download=False):
        raise NotImplementedError

    def merge_buffer(self, other):
        raise NotImplementedError


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
        self.frontend_dir = cf.get('frontend_dir', './pages-dist')
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
        body = json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8')
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

    def commit(self, message='auto update', skip_unchanged_download=False):
        self._ensure_project()

        files = {}
        if self.include_frontend:
            files.update(_collect_frontend_files(self.frontend_dir))
        for rel_path, content in self._buffer.items():
            files[rel_path] = content

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
                                files[rel] = json.dumps(old_data, ensure_ascii=False, indent=2).encode('utf-8')
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
                            files[rel] = json.dumps(old_data, ensure_ascii=False, indent=2).encode('utf-8')

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
                    files[stats_rel] = json.dumps(old_stats, ensure_ascii=False, indent=2).encode('utf-8')

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
            resp = self.session.get(
                f'{self.api_base}/accounts/{self.account_id}/pages/projects/{self.project_name}/upload-token',
                timeout=30,
            )
            resp.raise_for_status()
            jwt = (resp.json().get('result') or {}).get('jwt')
            if not jwt:
                raise RuntimeError(f'Cloudflare: 获取 upload-token 失败: {resp.text}')
            return jwt

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
        self.frontend_dir = gh.get('frontend_dir', './pages-dist')
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
        body = json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8')
        self._buffer[f'{self.path_prefix}/{key}'] = body
        self._local_write(key, data)
        logger.debug(f'GitHub buffer 写入: {self.path_prefix}/{key} ({len(body)} bytes)')

    def commit(self, message='auto update', skip_unchanged_download=False):
        files = {}
        if self.include_frontend:
            files.update(_collect_frontend_files(self.frontend_dir))
        for rel_path, content in self._buffer.items():
            files[rel_path] = content

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
                            files[rel] = json.dumps(old_data, ensure_ascii=False, indent=2).encode('utf-8')

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


def create_storage(config):
    storage_type = config['storage']['type']
    if storage_type == 'cloudflare':
        return CloudflareStorage(config)
    elif storage_type == 'github':
        return GitHubStorage(config)
    else:
        raise ValueError(f'不支持的存储类型: {storage_type}, 可选: cloudflare/github')


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


def send_notification(title, content):
    try:
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
        cat_failed = False
        cat_fail_reason = None
        cat_start = time.time()
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

            pages_fetched = page

            for bean in beans:
                items = standardize_bean(bean, prov_short, prov_name, attr, t1, t2, cmcc_code=prov_code, carrier=carrier_key)
                for item in items:
                    if item['id'] not in seen_ids:
                        seen_ids.add(item['id'])
                        all_items.append(item)
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

        cat_cost_ms = int((time.time() - cat_start) * 1000)
        meta = f'耗时{cat_cost_ms / 1000:.2f}s'
        if pages_fetched:
            meta += f' · 翻页{pages_fetched}次'
        if total_retries:
            meta += f' · 重试{total_retries}次'
        if request_failures:
            meta += f' · 失败{request_failures}次'

        if cat_failed:
            failed_categories.append(cat_desc)
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
        for prov in target_provinces:
            result = crawl_results.get(prov['name'])
            if result and result.get('items') is not None:
                items = result['items']
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

                from datetime import datetime as _dt
                today_start = _dt.strptime(crawl_time, '%Y-%m-%dT%H:%M:%S.%fZ').replace(hour=0, minute=0, second=0, microsecond=0)
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

    province_workers = config.get('schedule', {}).get('province_workers', 1)
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
                    _merge_prov_result(r_pw)
                else:
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
    storage.commit(message=f'stats rebuild {crawl_time[:10]}', skip_unchanged_download=True)
    logger.info(f'stats 重建完成，耗时 {crawl_duration_ms / 1000:.2f}s')


def run():
    config = parse_and_validate_config()
    storage = create_storage(config)

    if _is_deploy_frontend:
        logger.info('模式: 仅部署前端文件 (--deploy-frontend)')
        carriers = config.get('carriers', {})
        storage.set_all_carrier_keys(carriers.keys())
        all_prov_codes = [p['code'] for p in PROVINCES]
        for ck in carriers:
            storage.set_active_provinces(ck, all_prov_codes)
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

    _build_and_save_stats(config, storage, all_crawl_results, crawl_time, crawl_duration_ms, all_success_count, all_fail_count, old_stats)
    storage.commit(message=f'tariff update {crawl_time[:10]}')

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
        send_notification('资费监控-异常提醒', build_error_message(err_msg))

    if not all_skipped_flat and all_vol_flat and should_notify('error', config):
        vol_msg = f'资费监控波动预警（数据已正常更新）：{", ".join(all_vol_flat)}'
        send_notification('资费监控-波动预警', build_error_message(vol_msg))

    if all_partial_flat and should_notify('error', config):
        partial_msg = f'资费监控部分分类采集失败（数据已正常更新）：{", ".join(all_partial_flat)}'
        send_notification('资费监控-部分采集提醒', build_error_message(partial_msg))

    if total_success == 0 and total_fail > 0 and should_notify('all_fail', config):
        all_fail_flat = []
        for k, v in all_fail_count.items():
            if v > 0:
                all_fail_flat.append(f'{carrier_display(k)}:{v}省')
        fail_msg = f'全部省份采集失败：{", ".join(all_fail_flat)}'
        send_notification('资费监控-全部失败', build_error_message(fail_msg))

    if all_degraded_flat and should_notify('degrade', config):
        deg_msg = f'资费监控降级模式(仅对比不覆盖)：{", ".join(all_degraded_flat)}'
        send_notification('资费监控-降级提醒', build_error_message(deg_msg))

    has_any_change = False
    for carrier_key, crawl_results in all_crawl_results.items():
        carrier_label = CARRIER_DISPLAY_NAMES.get(carrier_key, carrier_key)
        carrier_cfg = get_carrier_config(config, carrier_key)
        summary = build_change_summary(carrier_key, crawl_results, carrier_cfg)
        if summary:
            has_any_change = True
            if should_notify('change', config):
                send_notification(f'{carrier_label}资费监控-变更通知', summary)
    if not has_any_change and not all_skipped_flat and not all_degraded_flat and not all_vol_flat and not all_partial_flat and should_notify('no_change', config):
        send_notification('资费监控-无变化', build_nochange_message())


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