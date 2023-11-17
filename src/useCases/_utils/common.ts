
import fs from 'fs';
import path from 'path'
import multer from 'multer'
import { v4 as uuid } from 'uuid';

interface parameters {
    route: string, file: any, body?: any, maxFiles: any, is_img: boolean
}

export const camelSentence = function camelSentence(str: any) {
    return (" " + str).toLowerCase().replace(/[^a-zA-Z0-9]+(.)/g, function (match, chr) {
        return chr.toUpperCase();
    })
};


// Settings
export const uploadFile = function ({ route, file, maxFiles, is_img }: parameters) {

    const storage = multer.diskStorage({
        destination: "./src/public" + route,

        filename: (req, file, cb) => {

            cb(null, uuid() + path.extname(file.originalname))
        }
    });
    return multer({
        storage: storage,
        fileFilter: is_img ? fileFilterImg : fileFilterAll
    }).fields([{
        name: file,
        maxCount: maxFiles,
    }]);
}

const fileFilterImg = (req: any, file: any, cb: any) => {
    console.log("Extension: " + file.mimetype)
    if (file.mimetype === "image/jpg" || file.mimetype === "image/jpeg" || file.mimetype == "application/octet-stream" || file.mimetype == "image/png") {
        cb(null, true);

    } else {
        cb(new Error('Invalid format'), false);

    }
}
const fileFilterAll = (req: any, file: any, cb: any) => {
    cb(null, true);
}
/*const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {

        cb(null, uuid() + path.extname(file.originalname))
    }
});
export default multer({ storage: storage });*/



