function ObjectController(objects) {
    this.objects = objects;
}

ObjectController.prototype.makeOperation =
function(client, operationInfo, clientCallback) {
    try {
        this.objects[operationInfo.object]
        .makeOperation(client, operationInfo, clientCallback);
    }
    catch(err) {
        console.error("Object not implemented or failed (ObjectController)");
        console.error(operationInfo);
        console.error(this.objects);
    }
};

// export the class
module.exports = ObjectController;
